import { createClient } from "@supabase/supabase-js";
import {
    learnMmPerMinute,
    shouldSkipBeforeStart,
    type Fao56Settings,
    type PlannedCycle,
} from "@/lib/fao56";

/*
 * Serverske funkcije za FAO-56: /api/intelligent/run (plan, svakih 6 h)
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

// Komanda koju kontroler nije preuzeo/završio u ovom roku smatra se zaglavljenom.
const STALE_COMMAND_MS = 30 * 60_000;

type BlockingCommand = {
    id: string;
    status: string;
    source: string | null;
    scheduled_at: string | null;
    created_at: string;
    started_at: string | null;
    duration_minutes: number | null;
};

/*
 * Komanda koja blokira ciklus. Zaglavljene komande (kontroler ih nije
 * preuzeo ili završio u razumnom roku) se označe kao failed, a stara
 * zakazana intelligent komanda se otkaže - da ne blokiraju plan zauvijek.
 * Vraća opis blokade ili null ako je put slobodan.
 */
async function resolveBlockingCommand(
    supabase: Db,
    sensorId: string,
    now: number
): Promise<string | null> {
    const { data, error } = await supabase
        .from("irrigation_commands")
        .select("id, status, source, scheduled_at, created_at, started_at, duration_minutes")
        .eq("sensor_id", sensorId)
        .in("status", ["pending", "sent", "executing"]);

    if (error) throw error;

    let blocking: string | null = null;

    for (const cmd of (data ?? []) as BlockingCommand[]) {
        const scheduled = cmd.scheduled_at ? new Date(cmd.scheduled_at).getTime() : null;
        const since = scheduled ?? new Date(cmd.created_at).getTime();

        // Stara zakazana FAO-56 komanda (prethodna verzija) - zamjenjuje je plan.
        if (cmd.status === "pending" && cmd.source === "intelligent" && scheduled && scheduled > now) {
            await setCommandStatus(supabase, cmd.id, "pending", "cancelled");
            continue;
        }

        if (cmd.status === "executing") {
            const started = cmd.started_at ? new Date(cmd.started_at).getTime() : since;
            const limit = (Number(cmd.duration_minutes) || 0) * 60_000 + STALE_COMMAND_MS;

            if (now - started > limit) {
                await setCommandStatus(supabase, cmd.id, "executing", "failed");
                continue;
            }

            blocking = "zalijevanje je u toku";
            continue;
        }

        // pending / sent koje kontroler nije obradio
        if (now - since > STALE_COMMAND_MS) {
            await setCommandStatus(supabase, cmd.id, cmd.status, "failed");
            continue;
        }

        blocking = `čeka komandu u statusu "${cmd.status}"`;
    }

    return blocking;
}

async function setCommandStatus(supabase: Db, id: string, from: string, to: string) {
    const update: Record<string, string> = { status: to };

    if (to === "failed" || to === "cancelled") {
        update.completed_at = new Date().toISOString();
    }

    const { error } = await supabase
        .from("irrigation_commands")
        .update(update)
        .eq("id", id)
        .eq("status", from);

    if (error) throw error;
}

export type DispatchResult = {
    sensor_id: string;
    action: string;
    cycle?: string;
};

/*
 * Izvršavanje plana. Poziva ga /api/controller/commands pri svakom
 * upitu kontrolera (svake minute) - model se NE pokreće ponovo.
 * Za svaki senzor u intelligent režimu: ako je planirani ciklus na redu
 * i nema aktivne komande -> provjera senzora -> komanda ili preskok.
 * Rezultat se vraća u odgovoru rute (polje fao56) radi lakše provjere.
 */
export async function dispatchDueCycles(
    supabase: Db,
    sensorIds: string[]
): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    if (sensorIds.length === 0) return results;

    const { data: active, error: activeError } = await supabase
        .from("irrigation_settings")
        .select("sensor_id")
        .in("sensor_id", sensorIds)
        .eq("mode", "intelligent")
        .eq("active_strategy", "intelligent");

    if (activeError) throw activeError;

    const intelligentIds = (active ?? []).map((r) => r.sensor_id as string);
    if (intelligentIds.length === 0) return results;

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

        if (!cycle) {
            const next = plan.find((c) => c.status === "planned");
            results.push({
                sensor_id: settings.sensor_id,
                action: next ? `sljedeći ciklus ${next.at}` : "nema planiranih ciklusa",
            });
            continue;
        }

        const previousNote = cycle.note ?? null;
        let action: string;

        if (now - new Date(cycle.at).getTime() > MAX_CYCLE_DELAY_MS) {
            cycle.status = "skipped";
            cycle.note = "Propušteno (kontroler nije bio dostupan više od 2 h).";
            action = "preskočeno (zakašnjenje)";
        } else {
            const blocking = await resolveBlockingCommand(
                supabase,
                settings.sensor_id,
                now
            );

            if (blocking) {
                cycle.note = `Čeka: ${blocking}.`;
                action = `čeka (${blocking})`;
            } else {
                const moisture = await latestMoisture(supabase, settings.sensor_id, 60);

                if (
                    moisture !== null &&
                    shouldSkipBeforeStart(settings, moisture, cycle.minutes)
                ) {
                    cycle.status = "skipped";
                    cycle.note = `Tlo je već vlažno (${moisture}%) - preskočeno.`;
                    action = "preskočeno (vlažno tlo)";
                } else {
                    const commandId = await createCommand(
                        supabase,
                        settings.sensor_id,
                        cycle.minutes
                    );

                    if (commandId) {
                        cycle.commandId = commandId;
                        cycle.status = "sent";
                        cycle.note = null;
                        action = `komanda ${cycle.minutes} min`;
                    } else {
                        cycle.note = "Čeka: komanda nije upisana (druga aktivna komanda).";
                        action = "čeka (upis komande)";
                    }
                }
            }
        }

        results.push({ sensor_id: settings.sensor_id, action, cycle: cycle.at });

        // Upis samo kad se nešto promijenilo (ne svake minute dok ciklus čeka).
        if (cycle.status === "planned" && cycle.note === previousNote) continue;

        // Uslov na last_run_at sprječava da se pregazi novi plan.
        let update = supabase
            .from("fao56_settings")
            .update({ plan })
            .eq("sensor_id", settings.sensor_id);

        update = settings.last_run_at
            ? update.eq("last_run_at", settings.last_run_at)
            : update.is("last_run_at", null);

        const { error: updateError } = await update;
        if (updateError) throw updateError;
    }

    return results;
}

/*
 * Uči mm/min iz završenih zalijevanja: vlaga prije vs. 30 min - 3 h nakon.
 *
 * Čita iz irrigation_history, jer trigger u bazi završenu komandu prebaci
 * u historiju i obriše je iz irrigation_commands. Koristi STVARNO trajanje
 * (ended_at - started_at), a ne zadano. Uči iz svih zalijevanja (ručnih,
 * automatskih, intelligent) - protok ne zavisi od režima.
 * Usput upiše moisture_before / moisture_after u historiju.
 * Mijenja `settings` na licu mjesta da odluka koristi novu vrijednost.
 */
export async function calibrate(supabase: Db, settings: Fao56Settings) {
    const cutoff = new Date(Date.now() - 45 * 60_000).toISOString();

    const { data: rows, error } = await supabase
        .from("irrigation_history")
        .select("id, started_at, ended_at, duration")
        .eq("sensor_id", settings.sensor_id)
        .eq("status", "completed")
        .eq("calibrated", false)
        .not("ended_at", "is", null)
        .lte("ended_at", cutoff)
        .order("ended_at", { ascending: true })
        .limit(20);

    if (error) throw error;

    for (const row of rows ?? []) {
        const ended = new Date(row.ended_at).getTime();
        const started = row.started_at
            ? new Date(row.started_at).getTime()
            : ended - Number(row.duration) * 60_000;

        const actualMinutes = (ended - started) / 60_000;

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
            .gte("created_at", new Date(ended + 30 * 60_000).toISOString())
            .lte("created_at", new Date(ended + 3 * 3600_000).toISOString())
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();

        if (before && after && actualMinutes > 0) {
            const learned = learnMmPerMinute(
                settings,
                Number(before.moisture),
                Number(after.moisture),
                actualMinutes
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
        const { error: markError } = await supabase
            .from("irrigation_history")
            .update({
                calibrated: true,
                moisture_before: before ? Number(before.moisture) : null,
                moisture_after: after ? Number(after.moisture) : null,
            })
            .eq("id", row.id);

        if (markError) throw markError;
    }
}
