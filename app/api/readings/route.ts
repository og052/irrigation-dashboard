import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Graf prikazuje najviše 15 dana (uz pomjeranje unazad); starija očitanja
// briše dnevno čišćenje u bazi (supabase/cleanup.sql).
const READINGS_DAYS = 31;

// Supabase vraća najviše 1000 redova po upitu - čitamo u dijelovima.
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const sensorId = searchParams.get("sensor_id");

    if (!sensorId) {
        return NextResponse.json(
            { error: "Sensor ID is required" },
            { status: 400 }
        );
    }

    const since = new Date(
        Date.now() - READINGS_DAYS * 24 * 3600_000
    ).toISOString();

    const readings: { created_at: string; moisture: number }[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
        const from = page * PAGE_SIZE;

        const { data, error } = await supabase
            .from("sensor_data")
            .select("created_at, moisture")
            .eq("sensor_id", sensorId)
            .gte("created_at", since)
            .order("created_at", { ascending: true })
            .range(from, from + PAGE_SIZE - 1);

        if (error) {
            return NextResponse.json(
                { error: error.message },
                { status: 500 }
            );
        }

        readings.push(...(data ?? []));

        // Zadnja stranica - nema više podataka.
        if (!data || data.length < PAGE_SIZE) break;
    }

    return NextResponse.json({
        readings,
    });
}
