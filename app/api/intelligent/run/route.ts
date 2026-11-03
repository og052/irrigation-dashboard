import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
    decide,
    fetchForecast,
    learnMmPerMinute,
    type Fao56Settings,
} from "@/lib/fao56";

export const dynamic = "force-dynamic";

/*
 * FAO-56 inteligentno navodnjavanje.
 *
 * Pokreće se jednom dnevno (vercel.json -> crons) ili ručno:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/intelligent/run
 *
 * Za svaki senzor u "intelligent" režimu s uključenom strategijom:
 *   1. kalibriše mm/min iz prethodnih zalijevanja
 *   2. uzme svježu vlagu i Open-Meteo prognozu (ET0, kiša)
 *   3. izračuna deficit i, ako treba, napravi komandu za kontroler
 */

function getAdminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
        throw new Error("Supabase server environment is not configured.");
    }

    return createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

type Db = ReturnType<typeof getAdminClient>;

export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET;

    if (
        !secret ||
        request.headers.get("authorization") !== `Bearer ${secret}`
    ) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let supabase: Db;

    try {
        supabase = getAdminClient();
    } catch (error) {
        console.error("FAO56 config error:", error);
        return NextResponse.json(
            { error: "Server is not configured." },
            { status: 500 }
        );
    }

    const today = new Date().toISOString().slice(0, 10);

    const { data: active, error } = await supabase
        .from("irrigation_settings")
        .select("sensor_id")
        .eq("mode", "intelligent")
        .eq("active_strategy", "intelligent");

    if (error) {
        console.error("FAO56 settings error:", error);
        return NextResponse.json(
            { error: "Failed to load irrigation settings." },
            { status: 500 }
        );
    }

    const results = [];

    for (const { sensor_id } of active ?? []) {
        try {
            results.push(await runForSensor(supabase, sensor_id, today));
        } catch (e) {
            console.error("FAO56 run failed for", sensor_id, e);
            results.push({ sensor_id, error: String(e) });
        }
    }

    return NextResponse.json({ ran_at: new Date().toISOString(), results });
}

async function runForSensor(supabase: Db, sensorId: string, today: string) {
    /*
     * 1. Postavke (napravi red s default vrijednostima ako ne postoji)
     */

    const { data: existing, error: settingsError } = await supabase
        .from("fao56_settings")
        .select("*")
        .eq("sensor_id", sensorId)
        .maybeSingle();

    if (settingsError) throw settingsError;

    let row = existing;

    if (!row) {
        const inserted = await supabase
            .from("fao56_settings")
            .insert({ sensor_id: sensorId })
            .select("*")
            .single();

        if (inserted.error) throw inserted.error;
        row = inserted.data;
    }

    const settings = row as Fao56Settings;

    // Vodni bilans je dnevni - isti dan se ne računa dvaput.
    if (settings.last_run_date === today) {
        return { sensor_id: sensorId, skipped: "already ran today" };
    }

    /*
     * 2. Lokacija (sensors -> devices)
     */

    const { data: sensor, error: sensorError } = await supabase
        .from("sensors")
        .select("id, devices(latitude, longitude)")
        .eq("id", sensorId)
        .single();

    if (sensorError) throw sensorError;

    const devices = sensor.devices as unknown;
    const device = (Array.isArray(devices) ? devices[0] : devices) as {
        latitude: number | null;
        longitude: number | null;
    } | null;

    if (device?.latitude == null || device?.longitude == null) {
        return { sensor_id: sensorId, skipped: "device has no location" };
    }

    /*
     * 3. Kalibracija mm/min iz prethodnih zalijevanja
     */

    await calibrate(supabase, settings);

    /*
     * 4. Svježa vlaga (zadnja 3 sata)
     */

    const since = new Date(Date.now() - 3 * 3600_000).toISOString();

    const { data: reading, error: readingError } = await supabase
        .from("sensor_data")
        .select("moisture, created_at")
        .eq("sensor_id", sensorId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (readingError) throw readingError;

    const moisture =
        reading && Number.isFinite(Number(reading.moisture))
            ? Number(reading.moisture)
            : null;

    /*
     * 5. Prognoza + odluka
     */

    const forecast = await fetchForecast(
        Number(device.latitude),
        Number(device.longitude)
    );

    const decision = decide(settings, moisture, forecast);

    /*
     * 6. Komanda za kontroler
     */

    let commandId: string | null = null;
    let deficitToStore = decision.deficitMm;

    if (decision.shouldIrrigate) {
        const { data: activeCommands, error: activeError } = await supabase
            .from("irrigation_commands")
            .select("id")
            .eq("sensor_id", sensorId)
            .in("status", ["pending", "sent", "executing"])
            .limit(1);

        if (activeError) throw activeError;

        if (activeCommands && activeCommands.length > 0) {
            decision.reason += " Aktivna komanda već postoji - preskočeno.";
        } else {
            const { data: command, error: insertError } = await supabase
                .from("irrigation_commands")
                .insert({
                    sensor_id: sensorId,
                    command_type: "start_irrigation",
                    duration_minutes: decision.durationMinutes,
                    source: "intelligent",
                    status: "pending",
                })
                .select("id")
                .single();

            // 23505 = aktivna komanda je kreirana u istom trenutku.
            if (insertError && insertError.code !== "23505") {
                throw insertError;
            }

            commandId = command?.id ?? null;

            if (commandId) {
                deficitToStore = decision.deficitAfterMm;
            }
        }
    }

    /*
     * 7. Spremi stanje
     */

    const { error: updateError } = await supabase
        .from("fao56_settings")
        .update({
            deficit_mm: deficitToStore,
            last_run_date: today,
            last_decision: {
                ...decision,
                moisture,
                mmPerMinute: Number(settings.mm_per_minute),
                commandId,
                at: new Date().toISOString(),
            },
        })
        .eq("sensor_id", sensorId);

    if (updateError) throw updateError;

    return { sensor_id: sensorId, moisture, decision, command_id: commandId };
}

/*
 * Uči mm/min: vlaga prije zalijevanja vs. 30 min - 3 h nakon.
 * Mijenja `settings` na licu mjesta da odluka koristi novu vrijednost.
 */
async function calibrate(supabase: Db, settings: Fao56Settings) {
    const cutoff = new Date(Date.now() - 45 * 60_000).toISOString();

    const { data: commands, error } = await supabase
        .from("irrigation_commands")
        .select("id, started_at, completed_at, duration_minutes")
        .eq("sensor_id", settings.sensor_id)
        .eq("source", "intelligent")
        .eq("status", "completed")
        .eq("calibrated", false)
        .lte("completed_at", cutoff);

    if (error) throw error;

    for (const cmd of commands ?? []) {
        const completed = new Date(cmd.completed_at).getTime();
        const started = cmd.started_at
            ? new Date(cmd.started_at).getTime()
            : completed - cmd.duration_minutes * 60_000;

        const { data: before } = await supabase
            .from("sensor_data")
            .select("moisture")
            .eq("sensor_id", settings.sensor_id)
            .lte("created_at", new Date(started).toISOString())
            .gte("created_at", new Date(started - 2 * 3600_000).toISOString())
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        const { data: after } = await supabase
            .from("sensor_data")
            .select("moisture")
            .eq("sensor_id", settings.sensor_id)
            .gte("created_at", new Date(completed + 30 * 60_000).toISOString())
            .lte("created_at", new Date(completed + 3 * 3600_000).toISOString())
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();

        if (before && after) {
            const learned = learnMmPerMinute(
                settings,
                Number(before.moisture),
                Number(after.moisture),
                Number(cmd.duration_minutes)
            );

            if (learned !== null) {
                settings.mm_per_minute = learned;
                settings.calibrations = Number(settings.calibrations) + 1;

                const { error: updateError } = await supabase
                    .from("fao56_settings")
                    .update({
                        mm_per_minute: learned,
                        calibrations: settings.calibrations,
                    })
                    .eq("sensor_id", settings.sensor_id);

                if (updateError) throw updateError;
            }
        }

        // Označi kao obrađeno i kad nema podataka, da se ne pokušava stalno.
        await supabase
            .from("irrigation_commands")
            .update({ calibrated: true })
            .eq("id", cmd.id);
    }
}
