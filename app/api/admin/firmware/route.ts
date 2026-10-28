
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { isAdminRequest } from "@/lib/adminAuth";
import { renderFirmware, sketchFileName } from "@/lib/firmware";

export const dynamic = "force-dynamic";

/*
 * Adresa servera koja se upisuje u firmware. APP_URL (npr.
 * https://irrigation-dashboard-ashy.vercel.app) ima prednost,
 * inace se uzima adresa sa koje je admin otvorio panel.
 */
function getServerUrl(request: Request) {
    const configured = process.env.APP_URL?.trim();

    if (configured) {
        return configured.replace(/\/+$/, "");
    }

    return new URL(request.url).origin;
}

// Preuzimanje generisanog .ino fajla za uređaj ili senzor.
// GET /api/admin/firmware?type=controller&id=<device_id>
// GET /api/admin/firmware?type=sensor&id=<sensor_id>
export async function GET(request: Request) {
    if (!(await isAdminRequest())) {
        return NextResponse.json(
            { error: "Unauthorized" },
            { status: 401 }
        );
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const id = searchParams.get("id");

    if ((type !== "controller" && type !== "sensor") || !id) {
        return NextResponse.json(
            { error: "Invalid firmware request" },
            { status: 400 }
        );
    }

    try {
        const serverUrl = getServerUrl(request);

        let code: string;
        let values: Record<string, string>;

        if (type === "controller") {
            const { data: device, error } = await supabase
                .from("devices")
                .select("name, device_code")
                .eq("id", id)
                .maybeSingle();

            if (error) throw error;

            if (!device) {
                return NextResponse.json(
                    { error: "Device not found" },
                    { status: 404 }
                );
            }

            code = device.device_code;
            values = {
                DEVICE_CODE: device.device_code,
                DEVICE_NAME: device.name,
                SERVER_URL: serverUrl,
            };
        } else {
            const { data: sensor, error } = await supabase
                .from("sensors")
                .select("name, sensor_code, type, device_id")
                .eq("id", id)
                .maybeSingle();

            if (error) throw error;

            if (!sensor) {
                return NextResponse.json(
                    { error: "Sensor not found" },
                    { status: 404 }
                );
            }

            const { data: device, error: deviceError } = await supabase
                .from("devices")
                .select("name, device_code")
                .eq("id", sensor.device_id)
                .maybeSingle();

            if (deviceError) throw deviceError;

            code = sensor.sensor_code;
            values = {
                SENSOR_CODE: sensor.sensor_code,
                SENSOR_NAME: sensor.name,
                SENSOR_TYPE: sensor.type,
                DEVICE_CODE: device?.device_code ?? "",
                DEVICE_NAME: device?.name ?? "",
                SERVER_URL: serverUrl,
            };
        }

        const sketch = await renderFirmware(type, values);

        return new Response(sketch, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition": `attachment; filename="${sketchFileName(code)}"`,
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        console.error("ADMIN FIRMWARE ERROR:", error);

        return NextResponse.json(
            {
                error:
                    (error as { message?: string })?.message ??
                    "Failed to generate firmware",
            },
            { status: 500 }
        );
    }
}
