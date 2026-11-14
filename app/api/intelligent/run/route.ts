import { NextResponse } from "next/server";
import { fetchForecast, planIrrigation } from "@/lib/fao56";
import {
    activeSensorIds,
    calibrate,
    getAdminClient,
    isAuthorized,
    latestMoisture,
    loadLocation,
    loadSettings,
    type Db,
} from "@/lib/fao56Server";

export const dynamic = "force-dynamic";

/*
 * FAO-56 plan za narednih 6 sati - pokreće se svakih 6 h (00, 06, 12, 18h)
 * iz Supabase pg_cron-a (supabase/fao56_cron.sql):
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/intelligent/run
 *   ?force=1 - pokreni odmah, i ako je model nedavno radio (za testiranje)
 *
 * Na osnovu senzora i satne prognoze pravi PLAN od 0-3 zalijevanja
 * (svako najviše max_minutes) u narednih 6 sati. Ciklusi se izvršavaju
 * kad dođe njihovo vrijeme (dispatchDueCycles).
 */

// Zaštita od duplog pokretanja (npr. cron okinut dva puta).
const MIN_RUN_INTERVAL_MS = 4 * 3600_000;

export async function GET(request: Request) {
    if (!isAuthorized(request)) {
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

    let sensorIds: string[];

    try {
        sensorIds = await activeSensorIds(supabase);
    } catch (error) {
        console.error("FAO56 settings error:", error);
        return NextResponse.json(
            { error: "Failed to load irrigation settings." },
            { status: 500 }
        );
    }

    const force = new URL(request.url).searchParams.get("force") === "1";
    const results = [];

    for (const sensorId of sensorIds) {
        try {
            results.push(await runForSensor(supabase, sensorId, force));
        } catch (e) {
            console.error("FAO56 run failed for", sensorId, e);
            results.push({ sensor_id: sensorId, error: String(e) });
        }
    }

    return NextResponse.json({ ran_at: new Date().toISOString(), results });
}

async function runForSensor(supabase: Db, sensorId: string, force: boolean) {
    const settings = await loadSettings(supabase, sensorId);
    const now = Date.now();

    const lastRun = settings.last_run_at
        ? new Date(settings.last_run_at).getTime()
        : 0;

    if (!force && now - lastRun < MIN_RUN_INTERVAL_MS) {
        return {
            sensor_id: sensorId,
            skipped: "model je već radio u zadnja 4 sata (dodaj ?force=1 za test)",
        };
    }

    const location = await loadLocation(supabase, sensorId);

    if (!location) {
        return { sensor_id: sensorId, skipped: "device has no location" };
    }

    const forecast = await fetchForecast(location.latitude, location.longitude);

    await calibrate(supabase, settings);

    const moisture = await latestMoisture(supabase, sensorId, 180);
    const decision = planIrrigation(settings, moisture, forecast, now);

    // Novi plan zamjenjuje prethodni. deficit_mm važi za kraj perioda.
    const { error } = await supabase
        .from("fao56_settings")
        .update({
            deficit_mm: decision.deficitEndWithPlanMm,
            last_run_at: new Date(now).toISOString(),
            plan: decision.plan,
            last_decision: {
                ...decision,
                moisture,
                mmPerMinute: Number(settings.mm_per_minute),
                at: new Date(now).toISOString(),
            },
        })
        .eq("sensor_id", sensorId);

    if (error) throw error;

    return { sensor_id: sensorId, moisture, decision };
}
