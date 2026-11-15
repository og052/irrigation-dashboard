import { NextResponse } from "next/server";

/*
 * Vremenska prognoza preko našeg servera (proxy za Open-Meteo).
 *
 * Browser ne poziva api.open-meteo.com direktno, pa ga ne mogu blokirati
 * ad-blockeri, VPN-ovi ni mrežni filteri. Odgovor se čuva 10 minuta, pa
 * svi uređaji dijele isti odgovor i Open-Meteo dobija manje zahtjeva.
 *
 *   GET /api/weather?latitude=44.5&longitude=17.2&current=temperature_2m&timezone=auto
 *   (isti parametri kao Open-Meteo /v1/forecast)
 */

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const CACHE_SECONDS = 600;

// Dozvoljeni parametri i njihov format.
const LIST_PARAMS = ["current", "hourly", "daily"];
const NUMBER_LIMITS: Record<string, number> = {
    past_days: 92,
    forecast_days: 16,
};
const LIST_PATTERN = /^[a-z0-9_,]{1,300}$/;

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);

    const latitude = Number(searchParams.get("latitude"));
    const longitude = Number(searchParams.get("longitude"));

    if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
    ) {
        return NextResponse.json(
            { error: "Valid latitude and longitude are required" },
            { status: 400 }
        );
    }

    const params = new URLSearchParams({
        // Zaokruženo na ~1 km - bolje dijeljenje keša, ista prognoza.
        latitude: latitude.toFixed(2),
        longitude: longitude.toFixed(2),
        timezone: "auto",
    });

    for (const name of LIST_PARAMS) {
        const value = searchParams.get(name);

        if (value) {
            if (!LIST_PATTERN.test(value)) {
                return NextResponse.json(
                    { error: `Invalid ${name}` },
                    { status: 400 }
                );
            }

            params.set(name, value);
        }
    }

    for (const [name, max] of Object.entries(NUMBER_LIMITS)) {
        const value = searchParams.get(name);

        if (value !== null) {
            const n = Number(value);

            if (!Number.isInteger(n) || n < 0 || n > max) {
                return NextResponse.json(
                    { error: `Invalid ${name}` },
                    { status: 400 }
                );
            }

            params.set(name, String(n));
        }
    }

    try {
        const response = await fetch(`${OPEN_METEO_URL}?${params}`, {
            next: { revalidate: CACHE_SECONDS },
        });

        const body = await response.text();

        return new NextResponse(body, {
            status: response.status,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": response.ok
                    ? `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS}`
                    : "no-store",
            },
        });
    } catch (error) {
        console.error("WEATHER PROXY ERROR:", error);

        return NextResponse.json(
            { error: "Weather service unavailable" },
            { status: 502 }
        );
    }
}
