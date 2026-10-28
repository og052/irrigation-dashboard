import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { isAdminRequest } from "@/lib/adminAuth";
import { isNameTaken } from "@/lib/adminChecks";

// Dodavanje uređaja (kontrolera) korisniku.
export async function POST(request: Request) {
    if (!(await isAdminRequest())) {
        return NextResponse.json(
            { error: "Unauthorized" },
            { status: 401 }
        );
    }

    try {
        const body = await request.json();

        const userId = String(body.user_id ?? "");
        const name = String(body.name ?? "").trim();
        const deviceCode = String(body.device_code ?? "").trim();

        if (!userId || !name || !deviceCode) {
            return NextResponse.json(
                { error: "User, name and device code are required" },
                { status: 400 }
            );
        }

        const { data: user, error: userError } = await supabase
            .from("users")
            .select("id")
            .eq("id", userId)
            .maybeSingle();

        if (userError) {
            throw userError;
        }

        if (!user) {
            return NextResponse.json(
                { error: "User not found" },
                { status: 404 }
            );
        }

        // device_code koristi kontroler za heartbeat, mora biti jedinstven.
        const { data: existing, error: existingError } = await supabase
            .from("devices")
            .select("id")
            .eq("device_code", deviceCode)
            .maybeSingle();

        if (existingError) {
            throw existingError;
        }

        if (existing) {
            return NextResponse.json(
                { error: `Device code "${deviceCode}" is already taken` },
                { status: 409 }
            );
        }

        // Ime uređaja mora biti jedinstveno.
        if (await isNameTaken("devices", name)) {
            return NextResponse.json(
                { error: `Device name "${name}" is already taken` },
                { status: 409 }
            );
        }

        const { data: device, error } = await supabase
            .from("devices")
            .insert({
                user_id: userId,
                name,
                device_code: deviceCode,
            })
            .select("id, name, device_code, last_seen, user_id")
            .single();

        if (error) {
            throw error;
        }

        return NextResponse.json({ success: true, device });
    } catch (error) {
        console.error("ADMIN CREATE DEVICE ERROR:", error);

        return NextResponse.json(
            {
                error:
                    (error as { message?: string })?.message ??
                    "Invalid request",
            },
            { status: 500 }
        );
    }
}
