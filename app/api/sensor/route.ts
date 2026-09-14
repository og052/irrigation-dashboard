import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST(request: Request) {
    try {
        const data = await request.json();

        if (!Array.isArray(data)) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Expected an array of sensor readings",
                },
                { status: 400 }
            );
        }

        const sensorCodes = data.map((item) => item.sensor_code);

        // Pronađi senzore po njihovom sensor_code
        const { data: sensors, error: sensorsError } = await supabase
            .from("sensors")
            .select("id, sensor_code")
            .in("sensor_code", sensorCodes);

        if (sensorsError) {
            console.error("SENSORS ERROR:", sensorsError.message);

            return NextResponse.json(
                {
                    success: false,
                    error: sensorsError.message,
                },
                { status: 500 }
            );
        }

        // Provjera da li svi senzori postoje
        if (!sensors || sensors.length !== data.length) {
            return NextResponse.json(
                {
                    success: false,
                    error: "One or more sensors were not found",
                },
                { status: 400 }
            );
        }

        // Pretvori sensor_code u sensor_id
        const sensorData = data.map((reading) => {
            const sensor = sensors.find(
                (s) => s.sensor_code === reading.sensor_code
            );

            return {
                sensor_id: sensor!.id,
                moisture: reading.moisture,
            };
        });

        // Upis mjerenja
        const { data: insertedData, error } = await supabase
            .from("sensor_data")
            .insert(sensorData)
            .select();

        if (error) {
            console.error("SUPABASE ERROR:", error.message);

            return NextResponse.json(
                {
                    success: false,
                    error: error.message,
                },
                { status: 500 }
            );
        }

        console.log("SAVED:", insertedData);

        return NextResponse.json({
            success: true,
            data: insertedData,
        });

    } catch (error) {
        console.error("API ERROR:", error);

        return NextResponse.json(
            {
                success: false,
                error: "Invalid request",
            },
            { status: 400 }
        );
    }
}