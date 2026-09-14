import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const sensorId = searchParams.get("sensor_id");

    if (!sensorId) {
        return NextResponse.json(
            { error: "Sensor ID is required" },
            { status: 400 }
        );
    }

    const { data: readings, error } = await supabase
        .from("sensor_data")
        .select("created_at, moisture")
        .eq("sensor_id", sensorId)
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