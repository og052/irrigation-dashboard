import { createClient } from "@supabase/supabase-js";
import {
    learnMmPerMinute,
    shouldSkipBeforeStart,
    type Fao56Settings,
    type PlannedCycle,
} from "@/lib/fao56";

/*
 * Serverske funkcije za FAO-56: /api/intelligent/run (plan, jednom dnevno)
 * i dispatchDueCycles (izvršavanje plana, poziva ga ruta kontrolera).
 * Koristi service role ključ - samo na serveru, nikad u browseru.
 */

export function getAdminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
        throw new Error("Supabase server environment is not configured.");
    }

    return createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

export type Db = ReturnType<typeof getAdminClient>;

/** Bearer CRON_SECRET - Vercel cron ga šalje automatski. */
export function isAuthorized(request: Request) {
    const secret = process.env.CRON_SECRET;

    return (
        !!secret &&
        request.headers.get("authorization") === `Bearer ${secret}`
    );
}

/** Senzori u intelligent režimu s uključenom strategijom. */
export async function activeSensorIds(supabase: Db): Promise<string[]> {
    const { data, error } = await supabase
        .from("irrigation_settings")
        .select("sensor_id")
        .eq("mode", "intelligent")
        .eq("active_strategy", "intelligent");

    if (error) throw error;

    return (data ?? []).map((row) => row.sensor_id as string);
}

/** Postavke senzora; red s default vrijednostima se napravi ako ne postoji. */
export async function loadSettings(
    supabase: Db,
    sensorId: string
): Promise<Fao56Settings> {
    const { data: existing, error } = await supabase
        .from("fao56_settings")
        .select("*")
        .eq("sensor_id", sensorId)
        .maybeSingle();

    if (error) throw error;
    if (existing) return existing as Fao56Settings;

    const inserted = await supabase
        .from("fao56_settings")
        .insert({ sensor_id: sensorId })
        .select("*")
        .single();

    if (inserted.error) throw inserted.error;

    return inserted.data as Fao56Settings;
}

/** Lokacija uređaja kojem senzor pripada. */
export async function loadLocation(supabase: Db, sensorId: string) {
    const { data: sensor, error } = await supabase
        .from("sensors")
        .select("id, devices(latitude, longitude)")
        .eq("id", sensorId)
        .single();

    if (error) throw error;

    const devices = sensor.devices as unknown;
    const device = (Array.isArray(devices) ? devices[0] : devices) as {
        latitude: number | null;
        longitude: number | null;
    } | null;

    if (device?.latitude == null || device?.longitude == null) {
        return null;
    }

    return {
        latitude: Number(device.latitude),
        longitude: Number(device.longitude),
    };
}

/** Zadnja vlaga, samo ako je mlađa od maxAgeMinutes. */
export async function latestMoisture(
    supabase: Db,
    sensorId: string,
    maxAgeMinutes: number
): Promise<number | null> {
    const since = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();

    const { data, error } = await supabase
        .from("sensor_data")
        .select("moisture")
        .eq("sensor_id", sensorId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;

    const value = data ? Number(data.moisture) : NaN;
    return Number.isFinite(value) ? value : null;
}

/** Aktivna komanda (pending/sent/executing) za senzor, ako postoji. */
export async function activeCommand(supabase: Db, sensorId: string) {
    const { data, error } = await supabase
        .from("irrigation_commands")
        .select("id, status, source")
        .eq("sensor_id", sensorId)
        .in("status", ["pending", "sent", "executing"])
        .limit(1)
        .maybeSingle();

    if (error) throw error;

    return data as { id: string; status: string; source: string } | null;
}

/** Otkaže zakazano intelligent zalijevanje koje još nije poslano. */
export async function cancelPendingIntelligent(supabase: Db, commandId: string) {
    const { error } = await supabase
        .from("irrigation_commands")
        .update({ status: "cancelled" })
        .eq("id", commandId)
        .eq("status", "pending")
        .eq("source", "intelligent");

    if (error) throw error;
}

/** Komanda koju kontroler preuzima odmah. */
export async function createCommand(
    supabase: Db,
    sensorId: string,
    minutes: number
): Promise<string | null> {
    const { data, error } = await supabase
        .from("irrigation_commands")
        .insert({
            sensor_id: sensorId,
            command_type: "start_irrigation",
            duration_minutes: minutes,
            source: "intelligent",
            status: "pending",
        })
        .select("id")
        .single();

    // 23505 = aktivna komanda je kreirana u istom trenutku.
    if (error && error.code !== "23505") throw error;

    return data?.id ?? null;
}

// Ciklus koji kasni više od ovoga (npr. kontroler je bio offline) se preskače.
const MAX_CYCLE_DELAY_MS = 2 * 3600_000;

/*
 * Izvršavanje plana. Poziva ga /api/controller/commands pri svakom
 * upitu kontrolera (svake minute) - model se NE pokreće ponovo.
 * Za svaki senzor u intelligent režimu: ako je planirani ciklus na redu
 * i nema aktivne komande -> provjera senzora -> komanda ili preskok.
 */
export async function dispatchDueCycles(supabase: Db, sensorIds: string[]) {
    if (sensorIds.length === 0) return;

    const { data: active, error: activeError } = await supabase
        .from("irrigation_settings")
        .select("sensor_id")
        .in("sensor_id", sensorIds)
        .eq("mode", "intelligent")
        .eq("active_strategy", "intelligent");

    if (activeError) throw activeError;

    const intelligentIds = (active ?? []).map((r) => r.sensor_id as string);
    if (intelligentIds.length === 0) return;

    const { data: rows, error } = await supabase
        .from("fao56_settings")
        .select("*")
        .in("sensor_id", intelligentIds);

    if (error) throw error;

    const now = Date.now();

    for (const row of rows ?? []) {
        const settings = row as Fao56Settings;
        const plan: PlannedCycle[] = Array.isArray(settings.plan)
            ? settings.plan
            : [];

        const cycle = plan.find(
            (c) => c.status === "planned" && new Date(c.at).getTime() <= now
        );

        if (!cycle) continue;

        if (now - new Date(cycle.at).getTime() > MAX_CYCLE_DELAY_MS) {
            cycle.status = "skipped";
            cycle.note = "Propušteno (kontroler nije bio dostupan).";
        } else {
            // Prethodni ciklus / ručno zalijevanje još traje - čekamo.
            if (await activeCommand(supabase, settings.sensor_id)) continue;

            const moisture = await latestMoisture(supabase, settings.sensor_id, 60);

            if (
                moisture !== null &&
                shouldSkipBeforeStart(settings, moisture, cycle.minutes)
            ) {
                cycle.status = "skipped";
                cycle.note = `Tlo je već vlažno (${moisture}%) - preskočeno.`;
            } else {
                cycle.commandId = await createCommand(
                    supabase,
                    settings.sensor_id,
                    cycle.minutes
                );
                cycle.status = "sent";
            }
        }

        // Uslov na last_run_date sprječava da se pregazi novi plan.
        let update = supabase
            .from("fao56_settings")
            .update({ plan })
            .eq("sensor_id", settings.sensor_id);

        update = settings.last_run_date
            ? update.eq("last_run_date", settings.last_run_date)
            : update.is("last_run_date", null);

        const { error: updateError } = await update;
        if (updateError) throw updateError;
    }
}

/*
 * Uči mm/min: vlaga prije zalijevanja vs. 30 min - 3 h nakon.
 * Mijenja `settings` na licu mjesta da odluka koristi novu vrijednost.
 */
export async function calibrate(supabase: Db, settings: Fao56Settings) {
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
