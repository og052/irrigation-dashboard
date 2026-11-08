import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const READINGS_DAYS = 31;

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const sensorId = searchParams.get("sensor_id");

    if (!sensorId) {
        return NextResponse.json(
            { error: "Sensor ID is required" },
            { status: 400 }
        );
    }

    // Samo zadnjih 31 dan (graf prikazuje najviše 15 dana; starija
    // očitanja briše dnevno čišćenje u bazi - supabase/cleanup.sql).
    const since = new Date(
        Date.now() - READINGS_DAYS * 24 * 3600_000
    ).toISOString();

    const { data: readings, error } = await supabase
        .from("sensor_data")
        .select("created_at, moisture")
        .eq("sensor_id", sensorId)
        .gte("created_at", since)
        .order("created_at", { ascending: true });

    if (error) {
        return NextResponse.json(
            { error: error.message },
            { status: 500 }
        );
    }

    return NextResponse.json({
        readings,
    });
}