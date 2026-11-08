import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/*
 * Kontroler preuzima komandu neposredno prije izvršavanja.
 *   - zakazana komanda se ne može preuzeti prije scheduled_at
 */

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const commandId = body.command_id;
        const controllerId = body.controller_id;

        if (!commandId || !controllerId) {
            return NextResponse.json(
                { error: "Command ID and Controller ID are required" },
                { status: 400 }
            );
        }

        // 1. Kontroler
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

        // 2. Komanda i njen senzor
        const { data: command, error: commandError } = await supabase
            .from("irrigation_commands")
            .select(`
                id,
                sensor_id,
                command_type,
                duration_minutes,
                source,
                status,
                scheduled_at,
                created_at,
                sensors!inner (
                    id,
                    device_id
                )
            `)
            .eq("id", commandId)
            .maybeSingle();

        if (commandError) {
            console.error("COMMAND LOOKUP ERROR:", commandError);

            return NextResponse.json(
                { error: "Failed to retrieve command" },
                { status: 500 }
            );
        }

        if (!command) {
            return NextResponse.json(
                { error: "Command not found" },
                { status: 404 }
            );
        }

        // 3. Komanda mora pripadati ovom kontroleru
        const sensor = Array.isArray(command.sensors)
            ? command.sensors[0]
            : command.sensors;

        if (!sensor || sensor.device_id !== device.id) {
            return NextResponse.json(
                { error: "Command does not belong to this controller" },
                { status: 403 }
            );
        }

        // 4. Samo pending komande
        if (command.status !== "pending") {
            return NextResponse.json(
                { error: "Command is no longer pending", status: command.status },
                { status: 409 }
            );
        }

        // 5. Ne prije zakazanog vremena
        if (command.scheduled_at) {
            const scheduledTime = new Date(command.scheduled_at).getTime();

            if (!Number.isFinite(scheduledTime)) {
                return NextResponse.json(
                    { error: "Invalid scheduled time" },
                    { status: 500 }
                );
            }

            if (scheduledTime > Date.now()) {
                return NextResponse.json(
                    {
                        error: "Command is scheduled for a future time",
                        scheduled_at: command.scheduled_at,
                    },
                    { status: 409 }
                );
            }
        }

        // 6. Označi kao poslanu (uslov na scheduled_at ponovljen u UPDATE-u)
        const now = new Date().toISOString();

        let updateQuery = supabase
            .from("irrigation_commands")
            .update({ status: "sent" })
            .eq("id", commandId)
            .eq("status", "pending");

        if (command.scheduled_at) {
            updateQuery = updateQuery.lte("scheduled_at", now);
        }

        const { data: updatedCommand, error: updateError } = await updateQuery
            .select(`
                id,
                sensor_id,
                command_type,
                duration_minutes,
                source,
                status,
                scheduled_at,
                created_at,
                started_at
            `)
            .maybeSingle();

        if (updateError) {
            console.error("COMMAND CLAIM ERROR:", updateError);

            return NextResponse.json(
                { error: "Failed to claim command" },
                { status: 500 }
            );
        }

        if (!updatedCommand) {
            return NextResponse.json(
                {
                    error: "Command could not be claimed; it may have been claimed already or is not yet due",
                },
                { status: 409 }
            );
        }

        return NextResponse.json({
            success: true,
            command: updatedCommand,
        });
    } catch (error) {
        console.error("COMMAND CLAIM REQUEST ERROR:", error);

        return NextResponse.json(
            { error: "Invalid request" },
            { status: 400 }
        );
    }
}
