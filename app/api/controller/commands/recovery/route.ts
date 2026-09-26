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
         * 1. Find controller
         */

        const { data: device, error: deviceError } = await supabase
            .from("devices")
            .select("id, device_code")
            .eq("device_code", controllerId)
            .single();

        if (deviceError || !device) {
            return NextResponse.json(
                { error: "Controller not found" },
                { status: 404 }
            );
        }

        /*
         * 2. Find commands that were executing
         * on this controller.
         */

        const { data: commands, error: commandsError } =
            await supabase
                .from("irrigation_commands")
                .select(`
                    id,
                    sensor_id,
                    command_type,
                    duration_minutes,
                    source,
                    status,
                    created_at,
                    started_at,
                    sensors!inner (
                        id,
                        device_id
                    )
                `)
                .eq("status", "executing")
                .eq("sensors.device_id", device.id);

        if (commandsError) {
            console.error(
                "RECOVERY COMMAND ERROR:",
                commandsError
            );

            return NextResponse.json(
                { error: commandsError.message },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            commands: commands || [],
        });

    } catch (error) {
        console.error(
            "RECOVERY REQUEST ERROR:",
            error
        );

        return NextResponse.json(
            { error: "Invalid request" },
            { status: 400 }
        );
    }
}