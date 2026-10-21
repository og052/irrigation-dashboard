import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("user_id");

    if (!userId) {
        return NextResponse.json(
            { error: "User ID is required" },
            { status: 400 }
        );
    }

    // Pronađi devices ovog usera
    const { data: devices, error: deviceError } = await supabase
        .from("devices")
        .select("id, name, device_code, last_seen, latitude, longitude")
        .eq("user_id", userId);

    if (deviceError) {
        console.error("DEVICE ERROR:", deviceError);

        return NextResponse.json(
            { error: deviceError.message },
            { status: 500 }
        );
    }

    const deviceIds = devices.map(
        (device) => device.id
    );

    if (deviceIds.length === 0) {
        return NextResponse.json({
            devices: [],
        });
    }

    // Pronađi senzore tih devices
    const { data: sensors, error: sensorError } = await supabase
        .from("sensors")
        .select("id, name, sensor_code, type, device_id")
        .in("device_id", deviceIds);

    if (sensorError) {
        console.error("SENSOR ERROR:", sensorError);

        return NextResponse.json(
            { error: sensorError.message },
            { status: 500 }
        );
    }

    return NextResponse.json({
        devices,
        sensors,
    });
}