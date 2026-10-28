import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { isAdminRequest } from "@/lib/adminAuth";
import { isNameTaken } from "@/lib/adminChecks";

// Dodavanje senzora na uređaj.
export async function POST(request: Request) {
    if (!(await isAdminRequest())) {
        return NextResponse.json(
            { error: "Unauthorized" },
            { status: 401 }
        );
    }

    try {
        const body = await request.json();

        const deviceId = String(body.device_id ?? "");
        const name = String(body.name ?? "").trim();
        const sensorCode = String(body.sensor_code ?? "").trim();
        const type = String(body.type ?? "").trim();

        if (!deviceId || !name || !sensorCode || !type) {
            return NextResponse.json(
                { error: "Device, name, sensor code and type are required" },
                { status: 400 }
            );
        }

        const { data: device, error: deviceError } = await supabase
            .from("devices")
            .select("id")
            .eq("id", deviceId)
            .maybeSingle();

        if (deviceError) {
            throw deviceError;
        }

        if (!device) {
            return NextResponse.json(
                { error: "Device not found" },
                { status: 404 }
            );
        }

        // sensor_code šalje kontroler uz mjerenja, mora biti jedinstven.
        const { data: existing, error: existingError } = await supabase
            .from("sensors")
            .select("id")
            .eq("sensor_code", sensorCode)
            .maybeSingle();

        if (existingError) {
            throw existingError;
        }

        if (existing) {
            return NextResponse.json(
                { error: `Sensor code "${sensorCode}" is already taken` },
                { status: 409 }
            );
        }

        // Ime senzora mora biti jedinstveno.
        if (await isNameTaken("sensors", name)) {
            return NextResponse.json(
                { error: `Sensor name "${name}" is already taken` },
                { status: 409 }
            );
        }

        const { data: sensor, error } = await supabase
            .from("sensors")
            .insert({
                device_id: deviceId,
                name,
                sensor_code: sensorCode,
                type,
            })
            .select("id, name, sensor_code, type, device_id")
            .single();

        if (error) {
            throw error;
        }

        return NextResponse.json({ success: true, sensor });
    } catch (error) {
        console.error("ADMIN CREATE SENSOR ERROR:", error);

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
