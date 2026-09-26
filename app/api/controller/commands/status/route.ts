import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// ---------------------------------------------------------
// GET COMMAND STATUS
// ---------------------------------------------------------

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);

        const commandId = searchParams.get("command_id");
        const controllerId = searchParams.get("controller_id");

        if (!commandId || !controllerId) {
            return NextResponse.json(
                {
                    error:
                        "Command ID and Controller ID are required",
                },
                { status: 400 }
            );
        }

        // Find controller
        const { data: device, error: deviceError } =
            await supabase
                .from("devices")
                .select("id, device_code")
                .eq("device_code", controllerId)
                .single();

        if (deviceError || !device) {
            return NextResponse.json(
                {
                    error: "Controller not found",
                },
                { status: 404 }
            );
        }

        // Find command and verify that it belongs
        // to this controller through the sensor
        const { data: command, error: commandError } =
            await supabase
                .from("irrigation_commands")
                .select(`
id,
    status,
    sensors!inner(
        id,
        device_id
    )
        `)
                .eq("id", commandId)
                .single();

        if (commandError || !command) {
            return NextResponse.json(
                {
                    error: "Command not found",
                },
                { status: 404 }
            );
        }

        const sensor = Array.isArray(command.sensors)
            ? command.sensors[0]
            : command.sensors;

        if (!sensor || sensor.device_id !== device.id) {
            return NextResponse.json(
                {
                    error:
                        "Command does not belong to this controller",
                },
                { status: 403 }
            );
        }

        return NextResponse.json({
            status: command.status,
        });

    } catch (error) {
        console.error(
            "COMMAND STATUS GET ERROR:",
            error
        );

        return NextResponse.json(
            {
                error: "Invalid request",
            },
            { status: 400 }
        );
    }
}


// ---------------------------------------------------------
// UPDATE COMMAND STATUS
// ---------------------------------------------------------

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const commandId = body.command_id;
        const controllerId = body.controller_id;
        const status = body.status;

        if (!commandId || !controllerId || !status) {
            return NextResponse.json(
                {
                    error:
                        "Command ID, Controller ID and status are required",
                },
                { status: 400 }
            );
        }

        const allowedStatuses = [
            "executing",
            "completed",
            "failed",
            "canceled",
        ];

        if (!allowedStatuses.includes(status)) {
            return NextResponse.json(
                {
                    error: "Invalid status",
                },
                { status: 400 }
            );
        }

        // Find controller
        const { data: device, error: deviceError } =
            await supabase
                .from("devices")
                .select("id, device_code")
                .eq("device_code", controllerId)
                .single();

        if (deviceError || !device) {
            return NextResponse.json(
                {
                    error: "Controller not found",
                },
                { status: 404 }
            );
        }

        // Find command
        const { data: command, error: commandError } =
            await supabase
                .from("irrigation_commands")
                .select(`
id,
    sensor_id,
    status,
    sensors!inner(
        id,
        device_id
    )
        `)
                .eq("id", commandId)
                .single();

        if (commandError || !command) {
            return NextResponse.json(
                {
                    error: "Command not found",
                },
                { status: 404 }
            );
        }

        const sensor = Array.isArray(command.sensors)
            ? command.sensors[0]
            : command.sensors;

        if (!sensor || sensor.device_id !== device.id) {
            return NextResponse.json(
                {
                    error:
                        "Command does not belong to this controller",
                },
                { status: 403 }
            );
        }

        const updateData: {
            status: string;
            started_at?: string;
            completed_at?: string;
        } = {
            status,
        };

        if (status === "executing") {
            updateData.started_at =
                new Date().toISOString();
        }

        if (
            status === "completed" ||
            status === "canceled" ||
            status === "failed"
        ) {
            updateData.completed_at =
                new Date().toISOString();
        }

        const { data: updatedCommand, error: updateError } =
            await supabase
                .from("irrigation_commands")
                .update(updateData)
                .eq("id", commandId)
                .select(`
id,
    sensor_id,
    command_type,
    duration_minutes,
    source,
    status,
    created_at,
    started_at,
    completed_at
        `)
                .single();

        if (updateError) {
            console.error(
                "COMMAND STATUS UPDATE ERROR:",
                updateError
            );

            return NextResponse.json(
                {
                    error: updateError.message,
                },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            command: updatedCommand,
        });

    } catch (error) {
        console.error(
            "COMMAND STATUS REQUEST ERROR:",
            error
        );

        return NextResponse.json(
            {
                error: "Invalid request",
            },
            { status: 400 }
        );
    }
}