import { NextResponse } from "next/server";
import { fetchForecast, planIrrigation } from "@/lib/fao56";
import {
    activeCommand,
    activeSensorIds,
    calibrate,
    cancelPendingIntelligent,
    getAdminClient,
    isAuthorized,
    latestMoisture,
    loadLocation,
    loadSettings,
    type Db,
} from "@/lib/fao56Server";

export const dynamic = "force-dynamic";

/*
 * FAO-56 dnevni raspored - pokreće se JEDNOM dnevno u 20:00 (vercel.json):
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/intelligent/run
 *
 * Na osnovu senzora i satne prognoze za večeras i sutra pravi PLAN od
 * 0-3 zalijevanja (svako najviše max_minutes). Ciklusi se izvršavaju kad
 * dođe njihovo vrijeme (dispatchDueCycles), bez ponovnog pokretanja modela.
 */

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

    const results = [];

    for (const sensorId of sensorIds) {
        try {
            results.push(await runForSensor(supabase, sensorId));
        } catch (e) {
            console.error("FAO56 run failed for", sensorId, e);
            results.push({ sensor_id: sensorId, error: String(e) });
        }
    }

    return NextResponse.json({ ran_at: new Date().toISOString(), results });
}

async function runForSensor(supabase: Db, sensorId: string) {
    const settings = await loadSettings(supabase, sensorId);
    const location = await loadLocation(supabase, sensorId);

    if (!location) {
        return { sensor_id: sensorId, skipped: "device has no location" };
    }

    const forecast = await fetchForecast(location.latitude, location.longitude);

    // Lokalni datum - raspored se pravi jednom dnevno.
    const today = forecast.dates[0];

    if (settings.last_run_date === today) {
        return { sensor_id: sensorId, skipped: "already ran today" };
    }

    await calibrate(supabase, settings);

    const moisture = await latestMoisture(supabase, sensorId, 180);
    const decision = planIrrigation(settings, moisture, forecast, Date.now());

    // Novi plan zamjenjuje stari: neposlana intelligent komanda se otkazuje.
    const existing = await activeCommand(supabase, sensorId);

    if (existing?.status === "pending" && existing.source === "intelligent") {
        await cancelPendingIntelligent(supabase, existing.id);
    }

    // Vodni bilans: deficit na kraju sutrašnjeg dana uz plan.
    const { error } = await supabase
        .from("fao56_settings")
        .update({
            deficit_mm: decision.deficitEndWithPlanMm,
            last_run_date: today,
            plan: decision.plan,
            last_decision: {
                ...decision,
                moisture,
                mmPerMinute: Number(settings.mm_per_minute),
                at: new Date().toISOString(),
            },
        })
        .eq("sensor_id", sensorId);

    if (error) throw error;

    return { sensor_id: sensorId, moisture, decision };
}
