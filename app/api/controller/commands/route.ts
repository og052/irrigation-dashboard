import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { dispatchDueCycles, getAdminClient } from "@/lib/fao56Server";

export const dynamic = "force-dynamic";

/*
 * Kontroler periodično (svake minute) pita koje komande treba izvršiti.
 * Pri tome se izvršava i FAO-56 plan: ciklus kojem je došlo vrijeme
 * postaje komanda (dispatchDueCycles).
 * Vraćaju se samo pending komande kojima je došlo vrijeme:
 *   - scheduled_at IS NULL  -> odmah (ručno pokretanje, automatika)
 *   - scheduled_at <= sada  -> zakazano za kasnije
 */

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

        // 1. Kontroler
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

        // 2. Senzori ovog kontrolera
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
                controller_id: controllerId,
                commands: [],
            });
        }

        const sensorIds = sensors.map((sensor) => sensor.id);

        // FAO-56 plan - greška ovdje ne smije blokirati ostale komande.
        try {
            await dispatchDueCycles(getAdminClient(), sensorIds);
        } catch (error) {
            console.error("FAO56 DISPATCH ERROR:", error);
        }

        // 3. Pending komande kojima je došlo vrijeme
        const now = new Date().toISOString();

        const { data: commands, error: commandsError } = await supabase
            .from("irrigation_commands")
            .select(`
                id,
                sensor_id,
                command_type,
                duration_minutes,
                source,
                status,
                scheduled_at,
                created_at
            `)
            .in("sensor_id", sensorIds)
            .eq("status", "pending")
            .or(`scheduled_at.is.null,scheduled_at.lte.${now}`)
            .order("created_at", { ascending: true });

        if (commandsError) {
            console.error("IRRIGATION COMMANDS ERROR:", commandsError);

            return NextResponse.json(
                { error: commandsError.message },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            controller_id: controllerId,
            commands: commands ?? [],
        });
    } catch (error) {
        console.error("COMMAND REQUEST ERROR:", error);

        return NextResponse.json(
            { error: "Invalid request" },
            { status: 400 }
        );
    }
}
