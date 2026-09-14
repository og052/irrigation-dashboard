import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const controllerId = body.controller_id;

        if (!controllerId) {
            return NextResponse.json(
                { error: "Controller ID is required" },
                { status: 400 }
            );
        }

        const { data, error } = await supabase
            .from("devices")
            .update({
                last_seen: new Date().toISOString(),
            })
            .eq("device_code", controllerId)
            .select("id, device_code, last_seen")
            .single();

        if (error) {
            console.error("HEARTBEAT ERROR:", error);

            return NextResponse.json(
                { error: error.message },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            device: data,
        });
    } catch (error) {
        console.error("HEARTBEAT REQUEST ERROR:", error);

        return NextResponse.json(
            { error: "Invalid request" },
            { status: 400 }
        );
    }
}