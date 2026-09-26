import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);

        const controllerId = searchParams.get("controller_id");

        if (!controllerId) {
            return NextResponse.json(
                { error: "Controller ID is required" },
                { status: 400 }
            );
        }

        /*
         * 1. Find controller/device
         */

        const { data: device, error: deviceError } = await supabase
            .from("devices")
            .select("id, device_code")
            .eq("device_code", controllerId)
            .single();

        if (deviceError || !device) {
            console.error("CONTROLLER NOT FOUND:", deviceError);

            return NextResponse.json(
                { error: "Controller not found" },
                { status: 404 }
            );
        }

        /*
         * 2. Find sensors belonging to this controller
         */

        const { data: sensors, error: sensorsError } = await supabase
            .from("sensors")
            .select("id, sensor_code")
            .eq("device_id", device.id);

        if (sensorsError) {
            console.error("SENSORS ERROR:", sensorsError);

            return NextResponse.json(
                { error: sensorsError.message },
                { status: 500 }
            );
        }

        if (!sensors || sensors.length === 0) {
            return NextResponse.json({
                success: true,
                commands: [],
            });
        }

        const sensorIds = sensors.map((sensor) => sensor.id);

        /*
         * 3. Get pending irrigation commands
         */

        const { data: commands, error: commandsError } = await supabase
            .from("irrigation_commands")
            .select(`
                id,
                sensor_id,
                command_type,
                duration_minutes,
                source,
                status,
                created_at
            `)
            .in("sensor_id", sensorIds)
            .eq("status", "pending")
            .order("created_at", { ascending: true });

        if (commandsError) {
            console.error(
                "IRRIGATION COMMANDS ERROR:",
                commandsError
            );

            return NextResponse.json(
                { error: commandsError.message },
                { status: 500 }
            );
        }

        /*
         * 4. Return commands
         */

        return NextResponse.json({
            success: true,
            controller_id: controllerId,
            commands: commands ?? [],
        });

    } catch (error) {
        console.error(
            "COMMAND REQUEST ERROR:",
            error
        );

        return NextResponse.json(
            { error: "Invalid request" },
            { status: 400 }
        );
    }
}