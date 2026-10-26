
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function getAdminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (!url || !serviceKey) {
        throw new Error("Supabase server environment is not configured.");
    }

    return createClient(url, serviceKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    });
}

export async function POST(request: Request) {
    try {
        const schedulerToken = process.env.FUZZY_SCHEDULER_TOKEN;
        const authorization = request.headers.get("authorization");

        if (
            !schedulerToken ||
            authorization !== `Bearer ${schedulerToken}`
        ) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 }
            );
        }

        const body = await request.json();

        const sensorId = body.sensor_id;
        const duration = Number(body.duration_minutes);
        const scheduledAt = body.scheduled_at;

        if (
            typeof sensorId !== "string" ||
            !sensorId ||
            !Number.isInteger(duration) ||
            duration < 2 ||
            duration > 30 ||
            typeof scheduledAt !== "string"
        ) {
            return NextResponse.json(
                { error: "Invalid scheduling parameters." },
                { status: 400 }
            );
        }

        const scheduledDate = new Date(scheduledAt);
        const now = Date.now();

        if (Number.isNaN(scheduledDate.getTime())) {
            return NextResponse.json(
                { error: "Invalid scheduled_at timestamp." },
                { status: 400 }
            );
        }

        // Zakazivanje je dozvoljeno samo u naredna 24 sata.
        if (
            scheduledDate.getTime() < now - 60_000 ||
            scheduledDate.getTime() > now + 24 * 60 * 60 * 1000
        ) {
            return NextResponse.json(
                { error: "scheduled_at must be within the next 24 hours." },
                { status: 400 }
            );
        }

        const supabase = getAdminClient();

        // Senzor mora biti u intelligent režimu.
        const { data: setting, error: settingError } = await supabase
            .from("irrigation_settings")
            .select("sensor_id, mode")
            .eq("sensor_id", sensorId)
            .eq("mode", "intelligent")
            .maybeSingle();

        if (settingError) {
            throw settingError;
        }

        if (!setting) {
            return NextResponse.json(
                { error: "Sensor is not in intelligent mode." },
                { status: 403 }
            );
        }

        // Ne pravimo novu komandu ako već postoji aktivna
        // ili zakazana komanda za ovaj senzor.
        const { data: activeCommands, error: activeError } =
            await supabase
                .from("irrigation_commands")
                .select("id,status,scheduled_at")
                .eq("sensor_id", sensorId)
                .in("status", ["pending", "sent", "executing"])
                .limit(1);

        if (activeError) {
            throw activeError;
        }

        if (activeCommands && activeCommands.length > 0) {
            return NextResponse.json(
                {
                    error: "An active command already exists.",
                    existing_command: activeCommands[0],
                },
                { status: 409 }
            );
        }

        const { data: command, error: insertError } = await supabase
            .from("irrigation_commands")
            .insert({
                sensor_id: sensorId,
                command_type: "start_irrigation",
                duration_minutes: duration,
                source: "intelligent",
                status: "pending",
                scheduled_at: scheduledDate.toISOString(),
            })
            .select(
                "id,sensor_id,command_type,duration_minutes,source,status,scheduled_at,created_at"
            )
            .single();

        if (insertError) {
            // Na primjer, aktivna komanda je kreirana
            // u isto vrijeme drugim zahtjevom.
            if (insertError.code === "23505") {
                return NextResponse.json(
                    { error: "An active command already exists." },
                    { status: 409 }
                );
            }

            throw insertError;
        }

        return NextResponse.json(
            {
                message: "Irrigation command scheduled.",
                command,
            },
            { status: 201 }
        );
    } catch (error) {
        console.error("Scheduling irrigation command failed:", error);

        return NextResponse.json(
            { error: "Failed to schedule irrigation command." },
            { status: 500 }
        );
    }
}
