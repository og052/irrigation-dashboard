/*
 * Logika grafa vlage (bez React-a, da se može testirati):
 *   - prozor od 3 dana i vremenska zona lokacije senzora
 *   - prag i planirana zalijevanja AKTIVNOG režima
 *   - prognoza vlage za narednih 24 h (FAO-56 vodni bilans) s pojasom
 *     nesigurnosti
 */

/** Događaj koji IrrigationControl šalje kad se promijeni režim, prag ili raspored. */
export const SETTINGS_CHANGED_EVENT = "irrigation-settings-changed";

export const HOUR_MS = 3600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WINDOW_DAYS = 3;
export const PROJECTION_HOURS = 24;

/* ---------------------------------------------------------
 * Vremenska zona lokacije
 * --------------------------------------------------------- */

export type ChartZone = {
    timeZone?: string; // IANA, npr. "Europe/Sarajevo"
    offsetSeconds: number;
};

export function browserZone(): ChartZone {
    return {
        timeZone: undefined,
        offsetSeconds: -new Date().getTimezoneOffset() * 60,
    };
}

/** Početak lokalnog dana (u zoni lokacije) koji sadrži `ms`. */
export function startOfZoneDay(ms: number, zone: ChartZone) {
    const offsetMs = zone.offsetSeconds * 1000;
    return Math.floor((ms + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
}

/** "2026-11-15T13:00" (lokalno vrijeme lokacije) -> UTC ms */
export function zoneIsoToMs(local: string, offsetSeconds: number) {
    const [date, time = "00:00"] = local.split("T");
    const [y, m, d] = date.split("-").map(Number);
    const [hr, min] = time.split(":").map(Number);
    return Date.UTC(y, m - 1, d, hr, min) - offsetSeconds * 1000;
}

/** Lokalni dan u sedmici (0 = nedjelja) i "HH:MM" za UTC ms. */
export function zoneParts(ms: number, zone: ChartZone) {
    const local = new Date(ms + zone.offsetSeconds * 1000);
    return {
        weekday: local.getUTCDay(),
        hour: local.getUTCHours(),
        minute: local.getUTCMinutes(),
    };
}

/**
 * Prozor grafa: uvijek 3 dana. offsetDays = 0 -> jučer, danas, sutra;
 * svaki +1 pomjera prozor jedan dan unazad.
 */
export function chartWindow(nowMs: number, zone: ChartZone, offsetDays: number) {
    const t1 =
        startOfZoneDay(nowMs, zone) + 2 * DAY_MS - offsetDays * DAY_MS;
    return { t0: t1 - WINDOW_DAYS * DAY_MS, t1 };
}

/* ---------------------------------------------------------
 * Aktivni režim
 * --------------------------------------------------------- */

export type ScheduleRow = {
    id: string;
    start_time: string; // "HH:MM" ili "HH:MM:SS" (lokalno vrijeme lokacije)
    duration_minutes: number;
    monday: boolean;
    tuesday: boolean;
    wednesday: boolean;
    thursday: boolean;
    friday: boolean;
    saturday: boolean;
    sunday: boolean;
    enabled: boolean;
};

export type Fao56Params = {
    kc: number;
    root_depth_mm: number;
    taw_per_m: number;
    p: number;
    field_capacity: number;
    wilting_point: number;
    mm_per_minute: number;
};

export type Fao56Cycle = {
    at: string;
    minutes: number;
    status: "planned" | "sent" | "skipped";
};

export type PlanContext = {
    mode: string | null; // "manual" | "automatic" | "intelligent"
    activeStrategy: string | null; // "none" | "moisture" | "schedule" | "intelligent"
    moistureThreshold: number | null;
    moistureDuration: number | null;
    schedules: ScheduleRow[];
    fao: (Fao56Params & { plan: Fao56Cycle[] | null }) | null;
};

export type ActivePlan =
    | "moisture"
    | "schedule"
    | "intelligent"
    | "none";

export function activePlan(ctx: PlanContext | null): ActivePlan {
    if (!ctx) return "none";

    if (ctx.activeStrategy === "intelligent" && ctx.mode === "intelligent") {
        return "intelligent";
    }

    if (ctx.mode === "automatic") {
        if (ctx.activeStrategy === "moisture") return "moisture";
        if (ctx.activeStrategy === "schedule") return "schedule";
    }

    return "none";
}

export const PLAN_LABEL: Record<ActivePlan, string> = {
    moisture: "Automatic · by moisture",
    schedule: "Automatic · schedule",
    intelligent: "Intelligent · FAO-56",
    none: "Manual",
};

const DEFAULT_FAO: Fao56Params = {
    kc: 0.8,
    root_depth_mm: 300,
    taw_per_m: 150,
    p: 0.5,
    field_capacity: 70,
    wilting_point: 20,
    mm_per_minute: 0.5,
};

export function faoParams(ctx: PlanContext | null): Fao56Params {
    const f = ctx?.fao;
    if (!f) return DEFAULT_FAO;

    const n = (v: unknown, d: number) =>
        Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d;

    return {
        kc: n(f.kc, DEFAULT_FAO.kc),
        root_depth_mm: n(f.root_depth_mm, DEFAULT_FAO.root_depth_mm),
        taw_per_m: n(f.taw_per_m, DEFAULT_FAO.taw_per_m),
        p: n(f.p, DEFAULT_FAO.p),
        field_capacity: n(f.field_capacity, DEFAULT_FAO.field_capacity),
        wilting_point: n(f.wilting_point, DEFAULT_FAO.wilting_point),
        mm_per_minute: n(f.mm_per_minute, DEFAULT_FAO.mm_per_minute),
    };
}

/** Prag (vlaga %) aktivnog režima, ili null kad režim nema prag. */
export function thresholdFor(ctx: PlanContext | null): number | null {
    const plan = activePlan(ctx);

    if (plan === "moisture") {
        return ctx?.moistureThreshold ?? null;
    }

    if (plan === "intelligent" && ctx?.fao) {
        const f = faoParams(ctx);
        // FAO-56 RAW pretvoren u vlagu senzora: FC - p * (FC - WP)
        return Math.round(
            f.field_capacity - f.p * (f.field_capacity - f.wilting_point)
        );
    }

    return null;
}

/* ---------------------------------------------------------
 * Planirana zalijevanja
 * --------------------------------------------------------- */

export type PlannedIrrigation = {
    start: number;
    end: number;
    minutes: number;
    source: "schedule" | "intelligent" | "moisture";
    estimated: boolean; // procjena (prag vlage), a ne zakazan termin
};

const WEEKDAY_KEYS: (keyof ScheduleRow)[] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

/** Termini iz rasporeda u intervalu [from, to). */
export function scheduleOccurrences(
    schedules: ScheduleRow[],
    from: number,
    to: number,
    zone: ChartZone
): PlannedIrrigation[] {
    const result: PlannedIrrigation[] = [];

    for (const s of schedules) {
        if (!s.enabled) continue;

        const [hh, mm] = String(s.start_time).split(":").map(Number);
        if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;

        for (
            let day = startOfZoneDay(from, zone);
            day < to;
            day += DAY_MS
        ) {
            const start = day + (hh * 60 + mm) * 60_000;
            if (start < from || start >= to) continue;

            const weekday = zoneParts(day + 12 * HOUR_MS, zone).weekday;
            if (!s[WEEKDAY_KEYS[weekday]]) continue;

            const minutes = Number(s.duration_minutes) || 0;
            if (minutes <= 0) continue;

            result.push({
                start,
                end: start + minutes * 60_000,
                minutes,
                source: "schedule",
                estimated: false,
            });
        }
    }

    return result.sort((a, b) => a.start - b.start);
}

/** Planirani ciklusi FAO-56 modela od `from` nadalje. */
export function intelligentCycles(
    ctx: PlanContext | null,
    from: number
): PlannedIrrigation[] {
    const plan = Array.isArray(ctx?.fao?.plan) ? ctx!.fao!.plan! : [];

    return plan
        .filter((c) => c.status === "planned")
        .map((c) => {
            const start = new Date(c.at).getTime();
            const minutes = Number(c.minutes) || 0;
            return {
                start,
                end: start + minutes * 60_000,
                minutes,
                source: "intelligent" as const,
                estimated: false,
            };
        })
        .filter((c) => Number.isFinite(c.start) && c.end > from)
        .sort((a, b) => a.start - b.start);
}

/* ---------------------------------------------------------
 * Prognoza vlage (FAO-56 vodni bilans, satno)
 * --------------------------------------------------------- */

export type WeatherHour = {
    time: number;
    temperature: number;
    rainProbability: number;
    precipitation: number; // mm
    et0: number; // mm
};

export type ProjectionPoint = {
    time: number;
    moisture: number;
    low: number; // donja granica nesigurnosti
    high: number; // gornja granica nesigurnosti
};

export type Projection = {
    points: ProjectionPoint[];
    planned: PlannedIrrigation[]; // uključuje procijenjena (prag vlage)
};

const clamp = (v: number, min: number, max: number) =>
    Math.min(Math.max(v, min), max);

/** Nesigurnost prognoze (± % vlage) raste s vremenom. */
export function uncertainty(hoursAhead: number) {
    return Math.min(12, 2 + 0.4 * hoursAhead);
}

export function projectMoisture(
    startMoisture: number,
    nowMs: number,
    weather: WeatherHour[],
    ctx: PlanContext | null,
    planned: PlannedIrrigation[]
): Projection {
    const f = faoParams(ctx);
    const range = f.field_capacity - f.wilting_point;
    const taw = (f.taw_per_m * f.root_depth_mm) / 1000;

    const toDeficit = (m: number) =>
        clamp((f.field_capacity - m) / range, 0, 1) * taw;
    const toMoisture = (d: number) =>
        f.field_capacity - (d / taw) * range;

    const end = nowMs + PROJECTION_HOURS * HOUR_MS;
    const plan = activePlan(ctx);
    const threshold = thresholdFor(ctx);
    const all = [...planned];

    let deficit = toDeficit(startMoisture);
    let lastIrrigationEnd = -Infinity;

    const points: ProjectionPoint[] = [
        { time: nowMs, moisture: startMoisture, low: startMoisture, high: startMoisture },
    ];

    for (let t = nowMs; t < end; t += 15 * 60_000) {
        const hour = weather.find(
            (w) => t >= w.time && t < w.time + HOUR_MS
        );

        if (hour) {
            const rain = hour.precipitation >= 0.5 ? hour.precipitation * 0.8 : 0;
            deficit += (f.kc * hour.et0 - rain) / 4;
        }

        // Režim "po vlazi": procijeni kad bi vlaga pala ispod praga.
        if (
            plan === "moisture" &&
            threshold !== null &&
            toMoisture(deficit) < threshold &&
            t > lastIrrigationEnd + HOUR_MS &&
            !all.some((p) => t >= p.start && t < p.end)
        ) {
            const minutes = ctx?.moistureDuration ?? 10;
            all.push({
                start: t,
                end: t + minutes * 60_000,
                minutes,
                source: "moisture",
                estimated: true,
            });
        }

        const active = all.find((p) => t >= p.start && t < p.end);
        if (active) {
            deficit -= f.mm_per_minute * 15;
            lastIrrigationEnd = active.end;
        }

        deficit = clamp(deficit, 0, taw);

        const time = t + 15 * 60_000;
        const moisture = toMoisture(deficit);
        const u = uncertainty((time - nowMs) / HOUR_MS);

        points.push({
            time,
            moisture: Math.round(moisture * 10) / 10,
            low: Math.max(0, moisture - u),
            high: Math.min(100, moisture + u),
        });
    }

    return {
        points,
        planned: all
            .filter((p) => p.end > nowMs)
            .sort((a, b) => a.start - b.start),
    };
}
