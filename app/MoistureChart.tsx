"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
    DAY_MS,
    HOUR_MS,
    PLAN_LABEL,
    SETTINGS_CHANGED_EVENT,
    WINDOW_DAYS,
    activePlan,
    browserZone,
    chartWindow,
    intelligentCycles,
    projectMoisture,
    scheduleOccurrences,
    startOfZoneDay,
    thresholdFor,
    zoneIsoToMs,
    type ChartZone,
    type PlanContext,
    type PlannedIrrigation,
    type ProjectionPoint,
    type ScheduleRow,
    type WeatherHour,
} from "@/lib/chartPlan";

/*
 * Graf vlage: tri poravnata panela (vlaga, temperatura, kiša) sa
 * zajedničkom vremenskom osom.
 *   - uvijek 3 dana (jučer, danas, sutra); strelice / povlačenje za historiju
 *   - prag i planirana zalijevanja AKTIVNOG režima senzora
 *   - prognoza vlage za 24 h s pojasom nesigurnosti
 *   - sva vremena u vremenskoj zoni lokacije senzora
 */

type Reading = {
    created_at: string;
    moisture: number;
};

type Irrigation = {
    id: string;
    started_at: string;
    ended_at: string | null;
};

type Props = {
    data: Reading[];
    irrigations?: Irrigation[];
    latitude?: number | null;
    longitude?: number | null;
    sensorId?: string | null;
};

const COLORS = {
    moisture: "#2a78d6",
    moistureFill: "rgba(42, 120, 214, 0.12)",
    irrigation: "#1baf7a",
    irrigationFill: "rgba(27, 175, 122, 0.16)",
    temperature: "#eb6834",
    rain: "#6aa6e8",
    threshold: "#c98500",
    grid: "#eef0f3",
    border: "#e3e5e9",
    future: "rgba(241, 243, 246, 0.6)",
    text: "#8a8984",
    textStrong: "#52514e",
};

const PLAN_ICON = { schedule: "📅", intelligent: "🤖", moisture: "≈" } as const;
const PLAN_SOURCE = {
    schedule: "Schedule",
    intelligent: "FAO-56 plan",
    moisture: "Estimate · moisture threshold",
} as const;

const HISTORY_DAYS = 30; // koliko baza čuva očitanja (cleanup.sql)
const MAX_BACK = HISTORY_DAYS - 2;
const ML = 40;
const MR = 12;

/* ---------------------------------------------------------
 * Podaci: vrijeme (preko /api/weather) i postavke režima
 * --------------------------------------------------------- */

function useWeather(latitude?: number | null, longitude?: number | null) {
    const [weather, setWeather] = useState<WeatherHour[]>([]);
    const [zone, setZone] = useState<ChartZone>(browserZone);

    useEffect(() => {
        if (typeof latitude !== "number" || typeof longitude !== "number") {
            return;
        }

        let cancelled = false;

        async function load() {
            const url =
                `/api/weather?latitude=${latitude}&longitude=${longitude}` +
                `&hourly=temperature_2m,precipitation_probability,precipitation,et0_fao_evapotranspiration` +
                `&past_days=${HISTORY_DAYS + 1}&forecast_days=3&timezone=auto`;

            try {
                const response = await fetch(url);

                if (!response.ok) {
                    console.error("Weather API error:", response.status);
                    return;
                }

                const json = await response.json();
                const offset = Number(json.utc_offset_seconds ?? 0);
                const h = json.hourly ?? {};
                const times: string[] = h.time ?? [];

                if (cancelled) return;

                setZone({
                    timeZone: typeof json.timezone === "string" ? json.timezone : undefined,
                    offsetSeconds: offset,
                });

                setWeather(
                    times.map((t, i) => ({
                        time: zoneIsoToMs(t, offset),
                        temperature: h.temperature_2m?.[i] ?? 0,
                        rainProbability: h.precipitation_probability?.[i] ?? 0,
                        precipitation: h.precipitation?.[i] ?? 0,
                        et0: h.et0_fao_evapotranspiration?.[i] ?? 0,
                    }))
                );
            } catch (error) {
                console.error("Weather fetch error:", error);
            }
        }

        load();
        const interval = setInterval(load, 30 * 60_000);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [latitude, longitude]);

    return { weather, zone };
}

function usePlanContext(sensorId?: string | null) {
    // Postavke su vezane za senzor - stari senzor se nikad ne prikazuje.
    const [state, setState] = useState<{ sensorId: string; ctx: PlanContext } | null>(null);

    useEffect(() => {
        if (!sensorId) return;

        let cancelled = false;

        async function load() {
            const { data: settings, error } = await supabase
                .from("irrigation_settings")
                .select("id, mode, active_strategy")
                .eq("sensor_id", sensorId)
                .maybeSingle();

            if (error || !settings) {
                if (error) console.error("Chart settings error:", error);
                return;
            }

            const [moisture, schedules, fao] = await Promise.all([
                supabase
                    .from("irrigation_moisture_settings")
                    .select("threshold, duration_minutes")
                    .eq("irrigation_setting_id", settings.id)
                    .maybeSingle(),
                supabase
                    .from("irrigation_schedules")
                    .select("id, start_time, duration_minutes, monday, tuesday, wednesday, thursday, friday, saturday, sunday, enabled")
                    .eq("irrigation_setting_id", settings.id),
                supabase
                    .from("fao56_settings")
                    .select("kc, root_depth_mm, taw_per_m, p, field_capacity, wilting_point, mm_per_minute, plan")
                    .eq("sensor_id", sensorId)
                    .maybeSingle(),
            ]);

            if (cancelled) return;

            setState({
                sensorId: sensorId as string, ctx: {
                    mode: settings.mode,
                    activeStrategy: settings.active_strategy,
                    moistureThreshold:
                        moisture.data?.threshold != null ? Number(moisture.data.threshold) : null,
                    moistureDuration:
                        moisture.data?.duration_minutes != null ? Number(moisture.data.duration_minutes) : null,
                    schedules: (schedules.data ?? []) as ScheduleRow[],
                    fao: (fao.data as PlanContext["fao"]) ?? null,
                }
            });
        }

        load();

        const interval = setInterval(() => {
            if (!document.hidden) load();
        }, 60_000);

        const onChange = () => load();
        window.addEventListener(SETTINGS_CHANGED_EVENT, onChange);

        return () => {
            cancelled = true;
            clearInterval(interval);
            window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange);
        };
    }, [sensorId]);

    return state && state.sensorId === sensorId ? state.ctx : null;
}

/* ---------------------------------------------------------
 * Pomoćne funkcije za prikaz
 * --------------------------------------------------------- */

function fmt(ms: number, zone: ChartZone, opts: Intl.DateTimeFormatOptions) {
    return new Date(ms).toLocaleString([], { ...opts, timeZone: zone.timeZone });
}

const fmtTime = (ms: number, z: ChartZone) =>
    fmt(ms, z, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
// Datum uvijek kao "14.11." (nezavisno od jezika browsera).
function fmtDay(ms: number, z: ChartZone) {
    const parts = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", timeZone: z.timeZone })
        .formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("day")}.${get("month")}.`;
}
const fmtDateTime = (ms: number, z: ChartZone) => `${fmtDay(ms, z)} ${fmtTime(ms, z)}`;

function smoothPath(pts: [number, number][]) {
    if (pts.length === 0) return "";
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        const cx = (x0 + x1) / 2;
        d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
    }
    return d;
}

/** Pozicije kratkih oznaka planiranih zalijevanja, bez preklapanja. */
function plannedLabelPositions(
    items: PlannedIrrigation[],
    x: (t: number) => number,
    width: number,
    minX: number
) {
    const result: { item: PlannedIrrigation; lx: number }[] = [];
    let labelEnd = -Infinity;
    const tw = 36;

    for (const item of items) {
        const bx = x(item.start);
        const bw = Math.max(10, x(item.end) - bx);
        const lx = bx + bw + 3 + tw > width ? bx - 3 - tw : bx + bw + 3;
        if (lx <= labelEnd + 4 || lx < minX) continue;
        labelEnd = lx + tw;
        result.push({ item, lx });
    }

    return result;
}

function nearestBy<T>(items: T[], time: (item: T) => number, t: number, maxDiff: number) {
    let best: T | null = null;
    let bestDiff = Infinity;

    for (const item of items) {
        const diff = Math.abs(time(item) - t);
        if (diff < bestDiff) {
            best = item;
            bestDiff = diff;
        }
    }

    return bestDiff <= maxDiff ? best : null;
}

/* ---------------------------------------------------------
 * Komponenta
 * --------------------------------------------------------- */

export default function MoistureChart({
    data,
    irrigations = [],
    latitude,
    longitude,
    sensorId,
}: Props) {
    const { weather, zone } = useWeather(latitude, longitude);
    const ctx = usePlanContext(sensorId);

    const [now, setNow] = useState(() => Date.now());
    const [offsetDays, setOffsetDays] = useState(0);
    const [hoverT, setHoverT] = useState<number | null>(null);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
    const [width, setWidth] = useState(900);

    const containerRef = useRef<HTMLDivElement>(null);
    const dragStart = useRef<number | null>(null);

    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        const node = containerRef.current;
        if (!node) return;

        const observer = new ResizeObserver(([entry]) => {
            setWidth(Math.max(280, Math.round(entry.contentRect.width)));
        });

        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    const { t0, t1 } = chartWindow(now, zone, offsetDays);
    const nowVisible = now > t0 && now < t1;
    const narrow = width < 600;

    /* ---------- podaci ---------- */

    const readings = useMemo(
        () =>
            data
                .map((r) => ({ time: new Date(r.created_at).getTime(), moisture: Number(r.moisture) }))
                .filter((r) => Number.isFinite(r.time) && Number.isFinite(r.moisture))
                .sort((a, b) => a.time - b.time),
        [data]
    );

    const pastIrrigations = useMemo(
        () =>
            irrigations
                .map((i) => ({
                    id: i.id,
                    start: new Date(i.started_at).getTime(),
                    end: i.ended_at ? new Date(i.ended_at).getTime() : now,
                }))
                .filter((i) => i.end > t0 && i.start < t1),
        [irrigations, now, t0, t1]
    );

    const plan = activePlan(ctx);
    const threshold = thresholdFor(ctx);

    const { projection, planned } = useMemo(() => {
        const horizon = now + 2 * DAY_MS;
        let base: PlannedIrrigation[] = [];

        if (plan === "schedule") base = scheduleOccurrences(ctx?.schedules ?? [], now, horizon, zone);
        if (plan === "intelligent") base = intelligentCycles(ctx, now);

        const last = readings.at(-1);
        const fresh = last && now - last.time < 3 * HOUR_MS;

        if (!fresh || weather.length === 0) {
            return { projection: [] as ProjectionPoint[], planned: base };
        }

        const result = projectMoisture(last.moisture, now, weather, ctx, base);
        return {
            projection: result.points,
            planned: [...result.planned, ...base.filter((b) => b.start > now + 24 * HOUR_MS)]
                .filter((p, i, all) => all.findIndex((q) => q.start === p.start) === i)
                .sort((a, b) => a.start - b.start),
        };
    }, [plan, ctx, readings, weather, now, zone]);

    /* ---------- skale ---------- */

    const plotW = width - ML - MR;
    const x = (t: number) => ML + ((t - t0) / (t1 - t0)) * plotW;
    const tFromX = (px: number) => t0 + ((px - ML) / plotW) * (t1 - t0);

    const M = { h: 240, top: 22, bottom: 8 };
    const T = { h: 100, top: 8, bottom: 8 };
    const R = { h: 116, top: 8, bottom: 24 };

    const yM = (v: number) => M.top + (1 - v / 100) * (M.h - M.top - M.bottom);
    const yR = (v: number) => R.top + (1 - v / 100) * (R.h - R.top - R.bottom);

    const windowWeather = weather.filter((w) => w.time >= t0 - HOUR_MS && w.time <= t1);
    const temps = windowWeather.map((w) => w.temperature);
    const tMin = temps.length ? Math.floor(Math.min(...temps) / 5) * 5 : 0;
    const tMax = temps.length ? Math.max(tMin + 10, Math.ceil(Math.max(...temps) / 5) * 5) : 20;
    const yT = (v: number) => T.top + (1 - (v - tMin) / (tMax - tMin)) * (T.h - T.top - T.bottom);
    const tStep = tMax - tMin <= 20 ? 5 : 10;
    const tTicks: number[] = [];
    for (let v = tMin; v <= tMax; v += tStep) tTicks.push(v);

    // Oznake na osi: dani (i svakih 6 h na širokom ekranu).
    const ticks: { t: number; day: boolean }[] = [];
    for (let t = startOfZoneDay(t0, zone); t <= t1; t += 6 * HOUR_MS) {
        if (t < t0) continue;
        const day = Math.abs(startOfZoneDay(t, zone) - t) < 60_000;
        if (day || !narrow) ticks.push({ t, day });
    }

    /* ---------- elementi koji se ponavljaju u panelima ---------- */

    const gridX = (h: number, top: number, bottom: number) =>
        ticks.filter((k) => k.day).map((k) => (
            <line key={k.t} x1={x(k.t)} x2={x(k.t)} y1={top} y2={h - bottom} stroke={COLORS.border} strokeDasharray="3 3" />
        ));

    const futureShade = (h: number, top: number, bottom: number) =>
        nowVisible && (
            <>
                <rect x={x(now)} y={top} width={x(t1) - x(now)} height={h - top - bottom} fill={COLORS.future} />
                <line x1={x(now)} x2={x(now)} y1={top} y2={h - bottom} stroke={COLORS.textStrong} strokeWidth={1.5} />
            </>
        );

    const hoverLine = (h: number, top: number, bottom: number) =>
        hoverT !== null && (
            <line x1={x(hoverT)} x2={x(hoverT)} y1={top} y2={h - bottom} stroke={COLORS.text} strokeDasharray="2 3" />
        );

    /* ---------- vlaga ---------- */

    const windowReadings = readings.filter((r) => r.time >= t0 && r.time <= t1);
    const moistPts = windowReadings.map((r) => [x(r.time), yM(r.moisture)] as [number, number]);
    const projPts = nowVisible ? projection.filter((p) => p.time <= t1) : [];
    const bandPath = projPts.length > 1
        ? `M${projPts.map((p) => `${x(p.time)},${yM(p.high)}`).join(" L")} L${[...projPts].reverse().map((p) => `${x(p.time)},${yM(p.low)}`).join(" L")} Z`
        : "";

    const plannedInWindow = planned.filter((p) => p.end > t0 && p.start < t1);

    // Kratke oznake planiranih zalijevanja, bez preklapanja.
    const plannedLabels = plannedLabelPositions(plannedInWindow, x, width, ML).map(({ item, lx }) => (
        <text key={`l-${item.start}`} x={lx} y={M.top + 13} fontSize={11} fontWeight={600} fill={COLORS.irrigation}>
            {`${PLAN_ICON[item.source]}${item.minutes}′`}
        </text>
    ));

    /* ---------- interakcija ---------- */

    function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
        const rect = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * width;
        const t = tFromX(px);

        if (t < t0 || t > t1) {
            setHoverT(null);
            return;
        }

        const box = containerRef.current?.getBoundingClientRect();
        if (box) {
            let left = e.clientX - box.left + 14;
            if (left + 200 > box.width) left = e.clientX - box.left - 210;
            setTooltipPos({ x: Math.max(4, left), y: e.clientY - box.top + 12 });
        }

        setHoverT(t);
    }

    function shift(delta: number) {
        setOffsetDays((d) => Math.min(MAX_BACK, Math.max(0, d + delta)));
        setHoverT(null);
    }

    function onPointerDown(e: React.PointerEvent) {
        dragStart.current = e.clientX;
    }

    function onPointerUp(e: React.PointerEvent) {
        if (dragStart.current === null) return;
        const dx = e.clientX - dragStart.current;
        dragStart.current = null;

        const dayPx = width / WINDOW_DAYS;
        const days = Math.round(dx / dayPx) || (Math.abs(dx) > 40 ? Math.sign(dx) : 0);
        if (days) shift(days); // udesno = unazad u prošlost
    }

    const svgProps = {
        width: "100%",
        onPointerMove,
        onPointerLeave: () => setHoverT(null),
        onPointerDown,
        onPointerUp,
        onPointerCancel: () => { dragStart.current = null; },
        style: { touchAction: "pan-y", cursor: "grab", userSelect: "none" } as React.CSSProperties,
    };

    /* ---------- tooltip ---------- */

    let tooltip: React.ReactNode = null;

    if (hoverT !== null) {
        const future = nowVisible && hoverT > now;
        const measured = future ? null : nearestBy(readings, (r) => r.time, hoverT, 45 * 60_000);
        const projected = future ? nearestBy(projection, (p) => p.time, hoverT, 30 * 60_000) : null;
        const w = nearestBy(weather, (h) => h.time, hoverT, 45 * 60_000);
        const pastIrr = pastIrrigations.find((i) => hoverT >= i.start - 10 * 60_000 && hoverT <= i.end + 10 * 60_000);
        const plannedIrr = plannedInWindow.find((p) => hoverT >= p.start - 10 * 60_000 && hoverT <= p.end + 10 * 60_000);

        const row = (color: string, label: string, value: string) => (
            <div className="flex items-center gap-2 text-slate-600">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
                {label}
                <b className="ml-auto pl-3 font-semibold text-slate-900">{value}</b>
            </div>
        );

        tooltip = (
            <div
                className="pointer-events-none absolute z-10 min-w-[180px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg"
                style={{ left: tooltipPos.x, top: tooltipPos.y }}
            >
                <p className="mb-1 font-semibold text-slate-800">
                    {fmtDateTime(hoverT, zone)}{future ? " · forecast" : ""}
                </p>
                {measured && row(COLORS.moisture, "Moisture", `${measured.moisture.toFixed(1)}%`)}
                {projected && row(COLORS.moisture, "Moisture (forecast)", `${Math.round(projected.moisture)}% ±${Math.round(projected.high - projected.moisture)}`)}
                {w && row(COLORS.temperature, "Temperature", `${w.temperature.toFixed(1)}°C`)}
                {w && row(COLORS.rain, "Rain probability", `${w.rainProbability}%`)}
                {pastIrr && row(COLORS.irrigation, "Irrigation", `${Math.round((pastIrr.end - pastIrr.start) / 60_000)} min`)}
                {plannedIrr && row(COLORS.irrigation, plannedIrr.estimated ? "Expected irrigation" : "Planned irrigation", `${plannedIrr.minutes} min`)}
            </div>
        );
    }

    /* ---------- lista narednih zalijevanja ---------- */

    const upcoming = planned.filter((p) => p.start >= now - 5 * 60_000).slice(0, 5);

    const emptyUpcoming: Record<typeof plan, string> = {
        moisture: threshold !== null
            ? `Irrigation starts automatically when moisture drops below ${threshold}%. No drop below the threshold is expected in the next 24 h.`
            : "Irrigation starts automatically when moisture drops below the threshold.",
        schedule: "No scheduled irrigation in the next 48 h.",
        intelligent: "The model decided that no irrigation is needed in the current 6-hour period. It runs again at 00, 06, 12 and 18h.",
        none: "",
    };

    const rangeLabel = offsetDays === 0
        ? "Yesterday · Today · Tomorrow"
        : `${fmtDay(t0, zone)} – ${fmtDay(t1 - HOUR_MS, zone)}`;

    /* ---------- render ---------- */

    return (
        <div ref={containerRef} className="relative">

            {/* NAVIGACIJA + REŽIM */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">

                <div className="flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => shift(1)}
                        disabled={offsetDays >= MAX_BACK}
                        aria-label="One day back"
                        className="h-8 w-8 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-35"
                    >
                        ‹
                    </button>

                    <span className="min-w-[150px] text-center text-xs font-semibold text-slate-600">
                        {rangeLabel}
                    </span>

                    <button
                        type="button"
                        onClick={() => shift(-1)}
                        disabled={offsetDays === 0}
                        aria-label="One day forward"
                        className="h-8 w-8 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-35"
                    >
                        ›
                    </button>

                    {offsetDays > 0 && (
                        <button
                            type="button"
                            onClick={() => shift(-offsetDays)}
                            className="h-8 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                            Today
                        </button>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span className="inline-flex items-center gap-1.5"><i className="inline-block h-[3px] w-3.5 rounded" style={{ background: COLORS.moisture }} />Moisture</span>
                    <span className="inline-flex items-center gap-1.5"><i className="inline-block w-3.5 border-t-2 border-dashed" style={{ borderColor: COLORS.moisture }} />Forecast</span>
                    <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COLORS.irrigation }} />Irrigation</span>
                    {plan !== "none" && (
                        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `repeating-linear-gradient(135deg, ${COLORS.irrigation} 0 2px, transparent 2px 5px)`, outline: `1px dashed ${COLORS.irrigation}` }} />Planned</span>
                    )}
                    {threshold !== null && (
                        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-[3px] w-3.5 rounded" style={{ background: COLORS.threshold }} />Threshold</span>
                    )}
                </div>
            </div>

            {/* VLAGA */}
            <div className="flex justify-between text-xs text-slate-500">
                <span>Soil moisture (%)</span>
                <span className="font-medium text-slate-600">{PLAN_LABEL[plan]}</span>
            </div>

            <svg {...svgProps} viewBox={`0 0 ${width} ${M.h}`}>
                <defs>
                    <pattern id="planned-hatch" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                        <rect width={6} height={6} fill={COLORS.irrigationFill} />
                        <line x1={0} y1={0} x2={0} y2={6} stroke={COLORS.irrigation} strokeWidth={2} strokeOpacity={0.55} />
                    </pattern>
                </defs>

                {[0, 25, 50, 75, 100].map((v) => (
                    <g key={v}>
                        <line x1={ML} x2={width - MR} y1={yM(v)} y2={yM(v)} stroke={COLORS.grid} />
                        <text x={ML - 8} y={yM(v) + 4} textAnchor="end" fontSize={11} fill={COLORS.text}>{v}%</text>
                    </g>
                ))}
                {gridX(M.h, M.top, M.bottom)}
                {futureShade(M.h, M.top, M.bottom)}

                {nowVisible && (
                    <>
                        <text x={x(now) + 6} y={14} fontSize={11} fontWeight={600} fill={COLORS.textStrong}>now</text>
                        {width - MR - x(now) > 110 && (
                            <text x={width - MR} y={14} textAnchor="end" fontSize={11} fill={COLORS.text}>forecast →</text>
                        )}
                    </>
                )}

                {pastIrrigations.map((i) => {
                    const bx = x(Math.max(i.start, t0));
                    const bw = Math.max(4, x(Math.min(i.end, t1)) - bx);
                    return (
                        <g key={i.id}>
                            <rect x={bx} y={M.top} width={bw} height={M.h - M.top - M.bottom} fill={COLORS.irrigationFill} rx={2} />
                            <rect x={bx} y={M.top} width={bw} height={4} fill={COLORS.irrigation} rx={2} />
                        </g>
                    );
                })}

                {plannedInWindow.map((p) => {
                    const bx = x(p.start);
                    const bw = Math.max(10, x(p.end) - bx);
                    return (
                        <rect
                            key={`p-${p.start}`}
                            x={bx}
                            y={M.top}
                            width={bw}
                            height={M.h - M.top - M.bottom}
                            fill="url(#planned-hatch)"
                            stroke={COLORS.irrigation}
                            strokeDasharray="3 2"
                            strokeOpacity={p.estimated ? 0.5 : 1}
                            rx={3}
                        />
                    );
                })}
                {plannedLabels}

                {moistPts.length > 1 && (
                    <>
                        <path d={`${smoothPath(moistPts)} L${moistPts.at(-1)![0]},${yM(0)} L${moistPts[0][0]},${yM(0)} Z`} fill={COLORS.moistureFill} />
                        <path d={smoothPath(moistPts)} fill="none" stroke={COLORS.moisture} strokeWidth={2} strokeLinejoin="round" />
                    </>
                )}

                {projPts.length > 1 && (
                    <>
                        <path d={bandPath} fill={COLORS.moisture} fillOpacity={0.1} />
                        <path d={smoothPath(projPts.map((p) => [x(p.time), yM(p.moisture)]))} fill="none" stroke={COLORS.moisture} strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.85} />
                    </>
                )}

                {nowVisible && windowReadings.length > 0 && (
                    <circle cx={x(windowReadings.at(-1)!.time)} cy={yM(windowReadings.at(-1)!.moisture)} r={4.5} fill={COLORS.moisture} stroke="#fff" strokeWidth={2} />
                )}

                {threshold !== null && (
                    <>
                        <line x1={ML} x2={width - MR} y1={yM(threshold)} y2={yM(threshold)} stroke={COLORS.threshold} strokeWidth={1.5} strokeDasharray="6 4" />
                        <rect x={ML + 4} y={yM(threshold) - 17} width={168} height={15} rx={4} fill="#fff" fillOpacity={0.9} />
                        <text x={ML + 9} y={yM(threshold) - 6} fontSize={11} fontWeight={600} fill={COLORS.threshold}>
                            threshold {threshold}% · water needed below
                        </text>
                    </>
                )}

                {windowReadings.length === 0 && (
                    <text x={ML + plotW / 2} y={M.h / 2} textAnchor="middle" fontSize={12} fill={COLORS.text}>
                        No moisture readings in this period
                    </text>
                )}

                {hoverLine(M.h, M.top, M.bottom)}
            </svg>

            {/* TEMPERATURA */}
            <div className="mt-2 text-xs text-slate-500">Temperature (°C)</div>

            <svg {...svgProps} viewBox={`0 0 ${width} ${T.h}`}>
                {tTicks.map((v) => (
                    <g key={v}>
                        <line x1={ML} x2={width - MR} y1={yT(v)} y2={yT(v)} stroke={COLORS.grid} />
                        <text x={ML - 8} y={yT(v) + 4} textAnchor="end" fontSize={11} fill={COLORS.text}>{v}°</text>
                    </g>
                ))}
                {gridX(T.h, T.top, T.bottom)}
                {futureShade(T.h, T.top, T.bottom)}

                {(() => {
                    const past = windowWeather.filter((w) => w.time <= Math.min(now + HOUR_MS, t1));
                    const fut = windowWeather.filter((w) => w.time >= Math.max(now - HOUR_MS, t0));
                    return (
                        <>
                            {past.length > 1 && <path d={smoothPath(past.map((w) => [x(w.time), yT(w.temperature)]))} fill="none" stroke={COLORS.temperature} strokeWidth={2} />}
                            {nowVisible && fut.length > 1 && <path d={smoothPath(fut.map((w) => [x(w.time), yT(w.temperature)]))} fill="none" stroke={COLORS.temperature} strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.85} />}
                        </>
                    );
                })()}

                {hoverLine(T.h, T.top, T.bottom)}
            </svg>

            {/* KIŠA */}
            <div className="mt-2 text-xs text-slate-500">Rain probability (%)</div>

            <svg {...svgProps} viewBox={`0 0 ${width} ${R.h}`}>
                {[0, 50, 100].map((v) => (
                    <g key={v}>
                        <line x1={ML} x2={width - MR} y1={yR(v)} y2={yR(v)} stroke={COLORS.grid} />
                        <text x={ML - 8} y={yR(v) + 4} textAnchor="end" fontSize={11} fill={COLORS.text}>{v}%</text>
                    </g>
                ))}
                {gridX(R.h, R.top, R.bottom)}
                {futureShade(R.h, R.top, R.bottom)}

                {windowWeather
                    .filter((w) => w.rainProbability > 0 && w.time >= t0 && w.time < t1)
                    .map((w) => {
                        const bw = Math.max(1, x(w.time + HOUR_MS) - x(w.time) - 2);
                        const y0 = yR(w.rainProbability);
                        return (
                            <rect
                                key={w.time}
                                x={x(w.time) + 1}
                                y={y0}
                                width={bw}
                                height={yR(0) - y0}
                                fill={COLORS.rain}
                                fillOpacity={nowVisible && w.time >= now ? 0.55 : 1}
                                rx={Math.min(2, bw / 2)}
                            />
                        );
                    })}

                {ticks.map((k) => (
                    <text key={k.t} x={x(k.t)} y={R.h - 6} textAnchor="middle" fontSize={11} fontWeight={k.day ? 600 : 400} fill={COLORS.text}>
                        {k.day ? fmtDay(k.t, zone) : fmtTime(k.t, zone)}
                    </text>
                ))}

                {hoverLine(R.h, R.top, R.bottom)}
            </svg>

            <p className="mt-1 text-center text-[11px] text-slate-400">
                ← drag the chart or use the arrows to see earlier days
                {zone.timeZone && zone.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone
                    ? ` · times in ${zone.timeZone.split("/").pop()?.replace(/_/g, " ")} time`
                    : ""}
            </p>

            {/* NAREDNA ZALIJEVANJA */}
            {plan !== "none" && (
                <div className="mt-4 border-t border-slate-100 pt-4">
                    <p className="mb-2 text-sm font-semibold text-slate-600">Upcoming irrigation</p>

                    {upcoming.length === 0 ? (
                        <p className="text-sm text-slate-500">{emptyUpcoming[plan]}</p>
                    ) : (
                        <ul className="space-y-1.5">
                            {upcoming.map((p) => (
                                <li key={p.start} className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm">
                                    <span className="w-6 text-center text-base">{PLAN_ICON[p.source]}</span>
                                    <span className="min-w-0 flex-1">
                                        <span className="font-semibold text-slate-900">
                                            {p.estimated ? "≈ " : ""}{fmtDateTime(p.start, zone)} · {p.minutes} min
                                        </span>
                                        <span className="block text-xs text-slate-500">{PLAN_SOURCE[p.source]}</span>
                                    </span>
                                    <span className="whitespace-nowrap rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                                        {p.estimated ? "Expected" : "Planned"}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {tooltip}
        </div>
    );
}
