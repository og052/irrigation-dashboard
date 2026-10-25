"use client";

import { useEffect, useRef, useState } from "react";
import {
    ComposedChart,
    Line,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    ReferenceArea,
    ReferenceLine,
} from "recharts";

type Reading = {
    created_at: string;
    moisture: number;
};

type Irrigation = {
    id: string;
    started_at: string;
    ended_at: string | null;
};

type WeatherPoint = {
    time: number; // epoch ms
    temperature: number;
    precipitationProbability: number;
};

/*
 * Colors for each series - also used by the filter chips below
 * the chart, so changing one here keeps everything in sync.
 */
const COLORS = {
    moisture: "#2563eb",
    irrigation: "#10b981",
    temperature: "#f97316",
    rain: "#38bdf8",
};

const RANGE_PRESETS: { label: string; days: number }[] = [
    { label: "1D", days: 1 },
    { label: "2D", days: 2 },
    { label: "3D", days: 3 },
    { label: "7D", days: 7 },
    { label: "15D", days: 15 },
];

/*
 * You can scroll the window forward by at most this many days
 * past today - weather forecast only reaches this far ahead.
 */
const MAX_FORWARD_OFFSET = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

type ChartPeriod = {
    id: string;
    start: Date;
    end: Date;
    stillRunning: boolean;
    x1: number;
    x2: number;
};

type SeriesKey = "moisture" | "irrigation" | "temperature" | "rain";

function formatClockTime(date: Date) {
    return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
    });
}

function formatShortDate(date: Date) {
    return date.toLocaleDateString([], {
        day: "2-digit",
        month: "2-digit",
    });
}

function formatDateTime(date: Date, multiDay: boolean) {
    if (!multiDay) return formatClockTime(date);

    return date.toLocaleString([], {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function formatDuration(start: Date, end: Date) {
    const totalMinutes = Math.max(
        0,
        Math.round((end.getTime() - start.getTime()) / 60000)
    );

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours === 0) return `${minutes} min`;
    if (minutes === 0) return `${hours} h`;

    return `${hours} h ${minutes} min`;
}

/*
 * Fetches hourly temperature + rain probability from Open-Meteo
 * covering [rangeStart, rangeEnd). pastDays/forecastDays are
 * relative to "today", not to the window itself, since that's
 * how Open-Meteo's API works - so scrolling the window forward
 * or backward changes how far back/ahead we ask for.
 */
async function fetchWeather(
    latitude: number,
    longitude: number,
    rangeStart: Date,
    rangeEnd: Date
): Promise<WeatherPoint[] | undefined> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const pastDays = Math.max(
        0,
        Math.round((todayStart.getTime() - rangeStart.getTime()) / DAY_MS)
    );

    const forecastDays = Math.max(
        1,
        Math.round((rangeEnd.getTime() - todayStart.getTime()) / DAY_MS)
    );

    const url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${latitude}&longitude=${longitude}` +
        `&hourly=temperature_2m,precipitation_probability` +
        `&past_days=${pastDays}&forecast_days=${forecastDays}` +
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

        const times: string[] = json.hourly?.time ?? [];
        const temps: number[] = json.hourly?.temperature_2m ?? [];
        const rain: number[] = json.hourly?.precipitation_probability ?? [];

        return times.map((isoTime, index) => ({
            time: new Date(isoTime).getTime(),
            temperature: temps[index],
            precipitationProbability: rain[index],
        }));
    } catch (error) {
        console.error("Weather fetch error:", error);
        return undefined;
    }
}

/*
 * Custom tooltip content: reads each hovered point's OWN time
 * from its payload rather than trusting recharts' shared axis
 * label, which can disagree across mixed series types (and was
 * the cause of the wrong time tag on sensor readings).
 */
type ChartTooltipEntry = {
    dataKey?: string | number;
    value?: number | string | readonly (number | string)[];
    color?: string;
    payload?: {
        time?: number;
    };
};

type ChartTooltipProps = {
    active?: boolean;
    payload?: readonly ChartTooltipEntry[];
    multiDay: boolean;
};

function ChartTooltip({
    active,
    payload,
    multiDay,
}: ChartTooltipProps) {
    if (!active || !payload || payload.length === 0) {
        return null;
    }

    const time = payload[0]?.payload?.time;
    const label =
        typeof time === "number"
            ? formatDateTime(new Date(time), multiDay)
            : "";

    return (
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
            <p className="font-semibold text-slate-700">
                {label}
            </p>

            {payload.map((entry, index) => {
                const value = entry.value;

                if (
                    typeof value !== "number" ||
                    entry.dataKey === undefined
                ) {
                    return null;
                }

                let text = "";

                if (entry.dataKey === "moisture") {
                    text = `Moisture: ${value}%`;
                } else if (entry.dataKey === "temperature") {
                    text = `Temperature: ${value}\u00b0C`;
                } else if (entry.dataKey === "rain") {
                    text = `Rain probability: ${value}%`;
                }

                if (!text) {
                    return null;
                }

                return (
                    <p
                        key={`${String(entry.dataKey)}-${index}`}
                        className="mt-0.5"
                        style={{ color: entry.color }}
                    >
                        {text}
                    </p>
                );
            })}
        </div>
    );
}

type Props = {
    data: Reading[];
    irrigations?: Irrigation[];
    latitude?: number | null;
    longitude?: number | null;
};

export default function MoistureChart({
    data,
    irrigations = [],
    latitude,
    longitude,
}: Props) {
    const [rangeDays, setRangeDays] = useState(1);

    /*
     * 0 = window ends today, -1 = shifted back a day,
     * +1 = shifted forward a day (tomorrow), etc.
     */
    const [dayOffset, setDayOffset] = useState(0);

    const containerRef = useRef<HTMLDivElement>(null);

    const hasLocation =
        typeof latitude === "number" && typeof longitude === "number";

    const [weatherPoints, setWeatherPoints] = useState<WeatherPoint[]>([]);
    const [weatherLoading, setWeatherLoading] = useState(false);

    /*
     * Which series are turned on. Weather series only matter
     * when a location is available; they're ignored otherwise.
     */
    const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
        moisture: true,
        irrigation: true,
        temperature: true,
        rain: true,
    });

    /*
     * The currently shown irrigation tooltip. "pinned" is set by
     * a click/tap (works on touch devices, which have no hover)
     * and stays until the same area is tapped again. A plain
     * hover overrides it temporarily while the mouse is over an
     * area, then falls back to whatever is pinned.
     */
    const [tooltip, setTooltip] = useState<{
        id: string;
        x: number;
        y: number;
        pinned: boolean;
    } | null>(null);

    /*
     * Window end is "end of today" shifted by dayOffset days;
     * window start is rangeDays earlier. So dayOffset=0, 1D ->
     * just today. dayOffset=-1, 1D -> just yesterday. dayOffset
     * =1, 1D -> just tomorrow (weather forecast only).
     */
    const rangeEnd = new Date();
    rangeEnd.setHours(24, 0, 0, 0);
    rangeEnd.setDate(rangeEnd.getDate() + dayOffset);

    const rangeStart = new Date(rangeEnd);
    rangeStart.setDate(rangeStart.getDate() - rangeDays);

    const rangeStartMs = rangeStart.getTime();
    const rangeEndMs = rangeEnd.getTime();

    const multiDay = rangeDays > 1;

    /*
     * ---------------------------------------------------------
     * FETCH WEATHER for the current window
     * ---------------------------------------------------------
     */

    useEffect(() => {
        if (!hasLocation) {
            setWeatherPoints([]);
            return;
        }

        let cancelled = false;
        setWeatherLoading(true);

        fetchWeather(
            latitude as number,
            longitude as number,
            rangeStart,
            rangeEnd
        ).then((points) => {
            if (cancelled) return;
            if (points) setWeatherPoints(points);
            setWeatherLoading(false);
        });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasLocation, latitude, longitude, rangeDays, dayOffset]);

    const now = new Date();

    function clamp(ms: number) {
        return Math.min(Math.max(ms, rangeStartMs), rangeEndMs);
    }

    const moistureData = data
        .filter((reading) => {
            const t = new Date(reading.created_at).getTime();
            return t >= rangeStartMs && t <= rangeEndMs;
        })
        .map((reading) => {
            const date = new Date(reading.created_at);

            return {
                time: date.getTime(),
                moisture: Number(reading.moisture),
            };
        });

    const weatherData = weatherPoints
        .filter(
            (point) => point.time >= rangeStartMs && point.time <= rangeEndMs
        )
        .map((point) => ({
            time: point.time,
            temperature: point.temperature,
            rain: point.precipitationProbability,
        }));

    const periods: ChartPeriod[] = irrigations
        .map((irrigation) => {
            const start = new Date(irrigation.started_at);

            const end = irrigation.ended_at
                ? new Date(irrigation.ended_at)
                : now;

            return {
                id: irrigation.id,
                start,
                end,
                stillRunning: irrigation.ended_at === null,
                x1: clamp(start.getTime()),
                x2: clamp(end.getTime()),
            };
        })
        .filter(
            (period) =>
                period.x1 < period.x2 &&
                period.end.getTime() > rangeStartMs &&
                period.start.getTime() < rangeEndMs
        );

    /*
     * Tick positions: every 2 hours for a single day, or one
     * tick per day boundary for a multi-day range.
     */
    const ticks: number[] = [];

    if (!multiDay) {
        for (let h = 0; h <= 24; h += 2) {
            ticks.push(rangeStartMs + h * 60 * 60 * 1000);
        }
    } else {
        const cursor = new Date(rangeStart);

        while (cursor.getTime() <= rangeEndMs) {
            ticks.push(cursor.getTime());
            cursor.setDate(cursor.getDate() + 1);
        }
    }

    function tickFormatter(value: number) {
        const date = new Date(value);

        if (!multiDay) {
            return date.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
            });
        }

        return formatShortDate(date);
    }

    function positionFromEvent(e: { clientX: number; clientY: number }) {
        const rect = containerRef.current?.getBoundingClientRect();

        if (!rect) return { x: 0, y: 0 };

        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        };
    }

    function handleMouseEnter(
        period: ChartPeriod,
        e: { clientX: number; clientY: number }
    ) {
        const { x, y } = positionFromEvent(e);
        setTooltip({ id: period.id, x, y, pinned: false });
    }

    function handleMouseLeave() {
        setTooltip((current) => (current && current.pinned ? current : null));
    }

    function handleClick(
        period: ChartPeriod,
        e: { clientX: number; clientY: number }
    ) {
        setTooltip((current) => {
            if (current && current.id === period.id && current.pinned) {
                return null;
            }

            const { x, y } = positionFromEvent(e);
            return { id: period.id, x, y, pinned: true };
        });
    }

    const activePeriod = tooltip
        ? periods.find((period) => period.id === tooltip.id) ?? null
        : null;

    function toggleSeries(key: SeriesKey) {
        setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
    }

    function goToPreset(days: number) {
        setRangeDays(days);
        setDayOffset(0);
        setTooltip(null);
    }

    function shiftWindow(delta: number) {
        setDayOffset((prev) => Math.min(MAX_FORWARD_OFFSET, prev + delta));
        setTooltip(null);
    }

    /*
     * Label shown between the scroll arrows.
     */
    let windowLabel: string;

    if (!multiDay) {
        if (dayOffset === 0) windowLabel = "Today";
        else if (dayOffset === -1) windowLabel = "Yesterday";
        else if (dayOffset === 1) windowLabel = "Tomorrow";
        else windowLabel = formatShortDate(rangeStart);
    } else {
        const lastDay = new Date(rangeEnd.getTime() - DAY_MS);
        windowLabel = `${formatShortDate(rangeStart)} - ${formatShortDate(lastDay)}`;
    }

    const filterChips: {
        key: SeriesKey;
        label: string;
        color: string;
        available: boolean;
    }[] = [
            {
                key: "moisture",
                label: "Moisture",
                color: COLORS.moisture,
                available: true,
            },
            {
                key: "irrigation",
                label: `Irrigation (${periods.length})`,
                color: COLORS.irrigation,
                available: periods.length > 0,
            },
            {
                key: "temperature",
                label: "Temperature",
                color: COLORS.temperature,
                available: hasLocation,
            },
            {
                key: "rain",
                label: "Rain probability",
                color: COLORS.rain,
                available: hasLocation,
            },
        ];

    return (
        <div>

            {/* RANGE SELECTOR + DAY SCROLL */}

            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">

                <div className="flex flex-wrap gap-2">
                    {RANGE_PRESETS.map((preset) => (
                        <button
                            key={preset.label}
                            onClick={() => goToPreset(preset.days)}
                            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${rangeDays === preset.days && dayOffset === 0
                                    ? "border-blue-500 bg-blue-50 text-blue-600"
                                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                }`}
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>

                <div className="flex items-center gap-2">

                    <button
                        onClick={() => shiftWindow(-1)}
                        aria-label="Previous"
                        className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50"
                    >
                        &lt;
                    </button>

                    <span className="min-w-[90px] text-center text-xs font-medium text-slate-600">
                        {windowLabel}
                    </span>

                    <button
                        onClick={() => shiftWindow(1)}
                        disabled={dayOffset >= MAX_FORWARD_OFFSET}
                        aria-label="Next"
                        className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        &gt;
                    </button>

                    {hasLocation && weatherLoading && (
                        <span className="text-xs text-slate-400">
                            Loading weather...
                        </span>
                    )}

                </div>

            </div>

            <div
                ref={containerRef}
                style={{
                    width: "100%",
                    height: "340px",
                    position: "relative",
                }}
            >

                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart>
                        <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />

                        <XAxis
                            dataKey="time"
                            type="number"
                            domain={[rangeStartMs, rangeEndMs]}
                            ticks={ticks}
                            tickFormatter={tickFormatter}
                            tick={{ fill: "#374151", fontSize: 12 }}
                        />

                        {/* LEFT AXIS: percentages (moisture + rain chance) */}
                        <YAxis
                            yAxisId="percent"
                            domain={[0, 100]}
                            tick={{ fill: "#374151", fontSize: 12 }}
                            label={{
                                value: "%",
                                angle: -90,
                                position: "insideLeft",
                                fill: "#374151",
                            }}
                        />

                        {/* RIGHT AXIS: temperature */}
                        {hasLocation && (
                            <YAxis
                                yAxisId="temperature"
                                orientation="right"
                                domain={["auto", "auto"]}
                                tick={{
                                    fill: COLORS.temperature,
                                    fontSize: 12,
                                }}
                                label={{
                                    value: "\u00b0C",
                                    angle: 90,
                                    position: "insideRight",
                                    fill: COLORS.temperature,
                                }}
                            />
                        )}

                        <Tooltip
                            cursor={{ strokeDasharray: "3 3" }}
                            content={(props) => (
                                <ChartTooltip
                                    active={props.active}
                                    payload={
                                        props.payload as unknown as
                                        | readonly ChartTooltipEntry[]
                                        | undefined
                                    }
                                    multiDay={multiDay}
                                />
                            )}
                        />

                        {/* IRRIGATION AREAS - hover (or tap) for details */}

                        {visible.irrigation &&
                            periods.map((period) => (
                                <ReferenceArea
                                    key={`${period.id}-area`}
                                    yAxisId="percent"
                                    x1={period.x1}
                                    x2={period.x2}
                                    fill={COLORS.irrigation}
                                    fillOpacity={
                                        tooltip?.id === period.id ? 0.28 : 0.12
                                    }
                                    stroke="none"
                                    style={{ cursor: "pointer" }}
                                    onMouseEnter={(e: React.MouseEvent) =>
                                        handleMouseEnter(period, e)
                                    }
                                    onMouseMove={(e: React.MouseEvent) =>
                                        handleMouseEnter(period, e)
                                    }
                                    onMouseLeave={handleMouseLeave}
                                    onClick={(e: React.MouseEvent) =>
                                        handleClick(period, e)
                                    }
                                />
                            ))}

                        {visible.irrigation &&
                            periods.map((period) => (
                                <ReferenceLine
                                    key={`${period.id}-start`}
                                    yAxisId="percent"
                                    x={period.x1}
                                    stroke={COLORS.irrigation}
                                    strokeOpacity={0.7}
                                    strokeWidth={1.5}
                                />
                            ))}

                        {visible.irrigation &&
                            periods
                                .filter((period) => !period.stillRunning)
                                .map((period) => (
                                    <ReferenceLine
                                        key={`${period.id}-end`}
                                        yAxisId="percent"
                                        x={period.x2}
                                        stroke={COLORS.irrigation}
                                        strokeOpacity={0.7}
                                        strokeWidth={1.5}
                                    />
                                ))}

                        {/* RAIN PROBABILITY - shaded area, left axis */}

                        {hasLocation && visible.rain && (
                            <Area
                                yAxisId="percent"
                                data={weatherData}
                                dataKey="rain"
                                type="monotone"
                                stroke={COLORS.rain}
                                strokeWidth={1}
                                fill={COLORS.rain}
                                fillOpacity={0.15}
                                isAnimationActive={false}
                                connectNulls
                            />
                        )}

                        {/* TEMPERATURE - line, right axis */}

                        {hasLocation && visible.temperature && (
                            <Line
                                yAxisId="temperature"
                                data={weatherData}
                                dataKey="temperature"
                                type="monotone"
                                stroke={COLORS.temperature}
                                strokeWidth={2}
                                dot={false}
                                isAnimationActive={false}
                                connectNulls
                            />
                        )}

                        {/* MOISTURE - line, same style as the other series,
                            left axis */}

                        {visible.moisture && (
                            <Line
                                yAxisId="percent"
                                data={moistureData}
                                dataKey="moisture"
                                type="monotone"
                                stroke={COLORS.moisture}
                                strokeWidth={2}
                                dot={false}
                                isAnimationActive={false}
                                connectNulls
                            />
                        )}
                    </ComposedChart>
                </ResponsiveContainer>

                {/* HOVER TOOLTIP for irrigation periods */}

                {activePeriod && tooltip && (
                    <div
                        className="pointer-events-none absolute z-10 max-w-[220px] rounded-lg border bg-white px-3 py-2 text-xs shadow-lg"
                        style={{
                            left: Math.max(
                                8,
                                Math.min(
                                    tooltip.x + 12,
                                    (containerRef.current?.clientWidth ?? 0) -
                                    190
                                )
                            ),
                            top: Math.max(tooltip.y - 70, 8),
                            borderColor: `${COLORS.irrigation}55`,
                        }}
                    >

                        <p className="font-semibold text-slate-800">
                            Irrigation
                        </p>

                        <p className="mt-1 text-slate-600">
                            Started: {formatDateTime(activePeriod.start, multiDay)}
                        </p>

                        <p className="text-slate-600">
                            Ended:{" "}
                            {activePeriod.stillRunning
                                ? "still running"
                                : formatDateTime(activePeriod.end, multiDay)}
                        </p>

                        <p className="text-slate-600">
                            Duration:{" "}
                            {formatDuration(activePeriod.start, activePeriod.end)}
                        </p>

                    </div>
                )}

            </div>

            {/* FILTERS / LEGEND - click a chip to show/hide that series */}

            <div className="mt-3 flex flex-wrap gap-2">

                {filterChips
                    .filter((chip) => chip.available)
                    .map((chip) => (
                        <button
                            key={chip.key}
                            onClick={() => toggleSeries(chip.key)}
                            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition ${visible[chip.key]
                                    ? "border-slate-200 bg-white text-slate-700"
                                    : "border-slate-100 bg-slate-50 text-slate-400"
                                }`}
                        >
                            <span
                                className="h-2.5 w-2.5 rounded-full"
                                style={{
                                    backgroundColor: visible[chip.key]
                                        ? chip.color
                                        : "#cbd5e1",
                                }}
                            />
                            {chip.label}
                        </button>
                    ))}

            </div>

            {!hasLocation && (
                <p className="mt-2 text-xs text-slate-400">
                    Set a location for this device to see temperature and
                    rain probability here.
                </p>
            )}

        </div>
    );
}