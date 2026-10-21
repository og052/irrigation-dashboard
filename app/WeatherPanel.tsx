"use client";

import { useEffect, useState } from "react";

const REFRESH_MS = 10 * 60 * 1000; // 10 minutes

type WeatherData = {
    temperature: number;
    humidity: number;
    precipitationProbability: number | null;
    windSpeed: number;
    weatherCode: number;
};

/*
 * Minimal mapping of Open-Meteo's WMO weather codes to an emoji
 * and short label. https://open-meteo.com/en/docs - "WMO Weather
 * interpretation codes".
 */
function describeWeatherCode(code: number): {
    emoji: string;
    label: string;
} {
    if (code === 0) return { emoji: "☀️", label: "Clear sky" };
    if ([1, 2, 3].includes(code))
        return { emoji: "⛅", label: "Partly cloudy" };
    if ([45, 48].includes(code)) return { emoji: "🌫️", label: "Fog" };
    if ([51, 53, 55, 56, 57].includes(code))
        return { emoji: "🌦️", label: "Drizzle" };
    if ([61, 63, 65, 66, 67].includes(code))
        return { emoji: "🌧️", label: "Rain" };
    if ([71, 73, 75, 77].includes(code))
        return { emoji: "🌨️", label: "Snow" };
    if ([80, 81, 82].includes(code))
        return { emoji: "🌧️", label: "Rain showers" };
    if ([85, 86].includes(code))
        return { emoji: "🌨️", label: "Snow showers" };
    if ([95, 96, 99].includes(code))
        return { emoji: "⛈️", label: "Thunderstorm" };
    return { emoji: "🌡️", label: "—" };
}

async function fetchWeather(
    latitude: number,
    longitude: number
): Promise<WeatherData | undefined> {
    const url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${latitude}&longitude=${longitude}` +
        `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
        `&hourly=precipitation_probability` +
        `&timezone=auto`;

    try {
        const response = await fetch(url);

        if (!response.ok) {
            console.error(
                "Weather API error:",
                response.status,
                await response.text()
            );
            return undefined;
        }

        const json = await response.json();

        const current = json.current;

        /*
         * "current" has no precipitation probability - find the
         * closest hourly entry to the current time and use that.
         */
        let precipitationProbability: number | null = null;

        const hourlyTimes: string[] = json.hourly?.time ?? [];
        const hourlyProbabilities: number[] =
            json.hourly?.precipitation_probability ?? [];

        if (hourlyTimes.length > 0) {
            const nowMs = new Date(current.time).getTime();

            let closestIndex = 0;
            let closestDiff = Infinity;

            hourlyTimes.forEach((isoTime, index) => {
                const diff = Math.abs(
                    new Date(isoTime).getTime() - nowMs
                );

                if (diff < closestDiff) {
                    closestDiff = diff;
                    closestIndex = index;
                }
            });

            precipitationProbability =
                hourlyProbabilities[closestIndex] ?? null;
        }

        return {
            temperature: current.temperature_2m,
            humidity: current.relative_humidity_2m,
            precipitationProbability,
            windSpeed: current.wind_speed_10m,
            weatherCode: current.weather_code,
        };
    } catch (error) {
        console.error("Weather fetch error:", error);
        return undefined;
    }
}

type Props = {
    /*
     * Accepts undefined too, defensively - if the API that
     * supplies the device doesn't include these columns yet,
     * they'll be undefined rather than null.
     */
    latitude: number | null | undefined;
    longitude: number | null | undefined;
};

function hasCoordinates(
    latitude: number | null | undefined,
    longitude: number | null | undefined
): latitude is number {
    return typeof latitude === "number" && typeof longitude === "number";
}

export default function WeatherPanel({ latitude, longitude }: Props) {
    const [weather, setWeather] = useState<WeatherData | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!hasCoordinates(latitude, longitude)) {
            setWeather(null);
            setLoading(false);
            return;
        }

        let cancelled = false;

        async function refresh() {
            if (document.hidden) return;

            const result = await fetchWeather(
                latitude as number,
                longitude as number
            );

            if (!cancelled && result !== undefined) {
                setWeather(result);
            }

            if (!cancelled) setLoading(false);
        }

        refresh();

        const interval = setInterval(refresh, REFRESH_MS);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [latitude, longitude]);

    if (!hasCoordinates(latitude, longitude)) {
        return (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-5 text-center">
                <p className="text-sm text-slate-400">
                    No location set for this device yet.
                </p>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-sm text-slate-500">
                    Loading weather...
                </p>
            </div>
        );
    }

    if (!weather) {
        return (
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-sm text-slate-400">
                    Could not load weather data.
                </p>
            </div>
        );
    }

    const { emoji, label } = describeWeatherCode(weather.weatherCode);

    return (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">

            <div className="flex items-center justify-between">

                <div>
                    <p className="text-sm font-medium text-slate-500">
                        Weather at device location
                    </p>

                    <div className="mt-1 flex items-center gap-2">
                        <span className="text-2xl">{emoji}</span>

                        <span className="text-2xl font-bold text-slate-900">
                            {Math.round(weather.temperature)}°C
                        </span>

                        <span className="text-sm text-slate-500">
                            {label}
                        </span>
                    </div>
                </div>

            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">

                <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">Humidity</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                        {weather.humidity}%
                    </p>
                </div>

                <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">
                        Rain probability
                    </p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                        {weather.precipitationProbability !== null
                            ? `${weather.precipitationProbability}%`
                            : "—"}
                    </p>
                </div>

                <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">Wind</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                        {Math.round(weather.windSpeed)} km/h
                    </p>
                </div>

            </div>

        </div>
    );
}