/*
 * FAO-56 vodni bilans tla (Allen et al., FAO Irrigation and Drainage Paper 56).
 *
 *   deficit = deficit + ET0 * Kc - efektivna kiša - navodnjavanje
 *
 * Model se pokreće svakih 6 sati (00, 06, 12, 18h) i gleda SAMO naredni
 * period od 6 sati:
 *   1. trenutni deficit iz senzora vlage (ili vodnog bilansa ako nema očitanja)
 *   2. satna simulacija deficita kroz period (ET0, kiša iz prognoze)
 *   3. ako deficit u periodu pređe prag (RAW) -> zalijevanje u periodu:
 *      - termin s kišom u naredna 3 h se preskače (kiša će to uraditi)
 *      - tlo već ispod praga -> najraniji slobodni termin
 *      - inače termin s najmanjim isparavanjem, ali prije nego deficit
 *        pređe prag
 *   4. trajanje = deficit / naučeni mm po minuti (najviše max_minutes);
 *      ako treba više -> nastavak nakon pauze (ukupno najviše 3 ciklusa)
 * Ciklusi se izvršavaju kad dođe vrijeme (dispatchDueCycles u fao56Server.ts),
 * uz provjeru senzora neposredno prije - ako je pala kiša, ciklus se preskače.
 *
 * Protok vode nije poznat, pa se mm -> minute uči iz senzora (mm_per_minute).
 */

export type Fao56Settings = {
    sensor_id: string;
    kc: number;
    root_depth_mm: number;
    taw_per_m: number;
    p: number;
    field_capacity: number;
    wilting_point: number;
    mm_per_minute: number;
    calibrations: number;
    deficit_mm: number;
    last_run_at: string | null;
    max_minutes: number; // najviše minuta po jednom zalijevanju
    plan: PlannedCycle[] | null;
};

export type PlannedCycle = {
    at: string; // ISO (UTC)
    label: string; // npr. "14:00"
    minutes: number;
    purpose: string; // zašto je ciklus planiran
    status: "planned" | "sent" | "skipped";
    note?: string | null;
    commandId?: string | null;
};

export type HourlyPoint = {
    at: number; // UTC ms početka sata
    et0: number; // mm
    rain: number; // mm
    temperature: number; // °C
};

export type Forecast = {
    utcOffsetSeconds: number;
    hourly: HourlyPoint[];
};

export type SlotOption = {
    at: string;
    label: string;
    valid: boolean;
    note: string;
};

export type Fao56Decision = {
    shouldIrrigate: boolean;
    totalMinutes: number;
    plan: PlannedCycle[];
    windowStart: string; // ISO - početak perioda
    windowEnd: string; // ISO - kraj perioda (6 h)
    windowLabel: string; // npr. "12:00 - 18:00"
    deficitMm: number; // deficit sada
    deficitEndWindowMm: number; // na kraju perioda, bez zalijevanja
    deficitEndWithPlanMm: number; // na kraju perioda, sa planom
    rawMm: number; // prag
    tawMm: number;
    etcWindowMm: number; // potrošnja vode biljke u periodu
    rainWindowMm: number; // kiša u periodu
    maxTempWindow: number | null;
    source: "sensor" | "water_balance";
    urgent: boolean;
    slots: SlotOption[];
    reason: string;
};

export const MIN_MINUTES = 2;
export const MAX_CYCLES = 3;
export const WINDOW_HOURS = 6;

const RAIN_AFTER_HOURS = 3; // kiša u ovom periodu nakon termina ...
const RAIN_SKIP_MM = 2; // ... veća od ovoga čini termin nepotrebnim
const SOAK_MINUTES = 45; // pauza između dva uzastopna ciklusa
const FIRST_SLOT_DELAY_MIN = 5; // najraniji termin: 5 min nakon pokretanja

const clamp = (v: number, min: number, max: number) =>
    Math.min(Math.max(v, min), max);

const round = (v: number) => Math.round(v * 100) / 100;

export async function fetchForecast(
    latitude: number,
    longitude: number
): Promise<Forecast> {
    const url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${latitude}&longitude=${longitude}` +
        `&hourly=et0_fao_evapotranspiration,precipitation,temperature_2m` +
        `&past_days=1&forecast_days=2&timezone=auto`;

    const res = await fetch(url, { cache: "no-store" });

    if (!res.ok) {
        throw new Error(`Open-Meteo error ${res.status}`);
    }

    const json = await res.json();
    const offset = Number(json.utc_offset_seconds ?? 0);
    const h = json.hourly;

    if (!h || !Array.isArray(h.time) || h.time.length === 0) {
        throw new Error("Open-Meteo returned incomplete data");
    }

    const hourly: HourlyPoint[] = h.time.map((t: string, i: number) => ({
        at: localIsoToUtcMs(t, offset),
        et0: h.et0_fao_evapotranspiration[i] ?? 0,
        rain: h.precipitation[i] ?? 0,
        temperature: h.temperature_2m[i] ?? 0,
    }));

    return { utcOffsetSeconds: offset, hourly };
}

/** "2026-11-08T21:00" (lokalno) -> UTC ms */
function localIsoToUtcMs(local: string, offsetSeconds: number) {
    const [date, time = "00:00"] = local.split("T");
    const [y, m, d] = date.split("-").map(Number);
    const [hr, min] = time.split(":").map(Number);
    return Date.UTC(y, m - 1, d, hr, min) - offsetSeconds * 1000;
}

/** "HH:MM" po lokalnom vremenu lokacije. */
function localTime(ms: number, offsetSeconds: number) {
    const local = new Date(ms + offsetSeconds * 1000);
    return `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

/** Male kiše (<2 mm) uglavnom ispare; od veće ~80% uđe u tlo. */
export function effectiveRain(mm: number) {
    return mm < 2 ? 0 : mm * 0.8;
}

/** Satna efektivna kiša: sitna kiša (<0.5 mm/h) ispari. */
function effectiveHourlyRain(mm: number) {
    return mm < 0.5 ? 0 : mm * 0.8;
}

/** TAW - ukupno raspoloživa voda u zoni korijena (mm). */
export function totalAvailableWater(s: Fao56Settings) {
    return (Number(s.taw_per_m) * Number(s.root_depth_mm)) / 1000;
}

function sensorRange(s: Fao56Settings) {
    return Number(s.field_capacity) - Number(s.wilting_point);
}

/** Razlika u očitanju senzora (%) -> mm vode. */
export function moistureDeltaToMm(s: Fao56Settings, deltaPct: number) {
    return (deltaPct / sensorRange(s)) * totalAvailableWater(s);
}

/** Deficit (mm) direktno iz vlage tla. */
export function deficitFromMoisture(s: Fao56Settings, moisture: number) {
    const fraction = clamp(
        (Number(s.field_capacity) - moisture) / sensorRange(s),
        0,
        1
    );
    return fraction * totalAvailableWater(s);
}

function rainBetween(f: Forecast, from: number, to: number) {
    return f.hourly
        .filter((p) => p.at >= from && p.at < to)
        .reduce((sum, p) => sum + p.rain, 0);
}

function et0Between(f: Forecast, from: number, to: number) {
    return f.hourly
        .filter((p) => p.at >= from && p.at < to)
        .reduce((sum, p) => sum + p.et0, 0);
}

type Irrigation = { at: number; mm: number };

/**
 * Satna simulacija deficita od `from` do `to`, uz planirana zalijevanja.
 * Deficit ne ide ispod 0 (višak vode oteče) ni iznad TAW.
 */
function simulate(
    s: Fao56Settings,
    f: Forecast,
    start: number,
    from: number,
    to: number,
    irrigations: Irrigation[]
) {
    const kc = Number(s.kc);
    const taw = totalAvailableWater(s);
    let d = start;

    for (const p of f.hourly) {
        const hourEnd = p.at + 3600_000;
        if (hourEnd <= from || p.at >= to) continue;

        // Dio sata unutar [from, to)
        const part =
            (Math.min(hourEnd, to) - Math.max(p.at, from)) / 3600_000;

        d = clamp(d + (kc * p.et0 - effectiveHourlyRain(p.rain)) * part, 0, taw);

        for (const irr of irrigations) {
            if (irr.at >= Math.max(p.at, from) && irr.at < Math.min(hourEnd, to)) {
                d = clamp(d - irr.mm, 0, taw);
            }
        }
    }

    return d;
}

export function planIrrigation(
    s: Fao56Settings,
    moisture: number | null,
    f: Forecast,
    nowMs: number
): Fao56Decision {
    const kc = Number(s.kc);
    const taw = totalAvailableWater(s);
    const raw = Number(s.p) * taw;
    const mmPerMinute = Number(s.mm_per_minute);
    const maxMinutes = Number(s.max_minutes) || 60;
    const offset = f.utcOffsetSeconds;
    const windowEnd = nowMs + WINDOW_HOURS * 3600_000;

    // 1. Deficit sada: senzor, ili vodni bilans. Spremljeni deficit_mm
    //    važi za kraj prethodnog perioda (last_run_at + 6 h).
    const lastRun = s.last_run_at ? new Date(s.last_run_at).getTime() : null;
    const balanceAt = lastRun !== null ? lastRun + WINDOW_HOURS * 3600_000 : null;
    const deficit =
        moisture !== null
            ? deficitFromMoisture(s, moisture)
            : balanceAt !== null && balanceAt < nowMs && nowMs - balanceAt < 48 * 3600_000
                ? simulate(s, f, Number(s.deficit_mm), balanceAt, nowMs, [])
                : Number(s.deficit_mm);

    const deficitAt = (t: number, irrigations: Irrigation[]) =>
        simulate(s, f, deficit, nowMs, t, irrigations);

    const deficitEnd = deficitAt(windowEnd, []);
    const urgent = deficit >= raw;

    // Trenutak kad bi deficit prešao prag (ako se to desi u periodu).
    const crossing = urgent
        ? nowMs
        : f.hourly
            .map((p) => p.at + 3600_000)
            .filter((t) => t > nowMs && t <= windowEnd)
            .find((t) => deficitAt(t, []) >= raw) ?? windowEnd;

    // 2. Kandidati: za 5 min, pa svaki puni sat u periodu.
    const firstSlot = nowMs + FIRST_SLOT_DELAY_MIN * 60_000;
    const candidateTimes = [
        firstSlot,
        ...f.hourly
            .map((p) => p.at)
            .filter((t) => t > firstSlot && t < windowEnd),
    ];

    const evaluate = (at: number, irrigations: Irrigation[]) => {
        const rainAfter = rainBetween(f, at, at + RAIN_AFTER_HOURS * 3600_000);
        const depletion = deficitAt(at, irrigations);
        const neededMinutes = Math.round(depletion / mmPerMinute);
        const evap = et0Between(f, at, at + 3600_000);

        return {
            at,
            label: localTime(at, offset),
            depletion,
            neededMinutes,
            minutes: Math.min(neededMinutes, maxMinutes),
            valid: rainAfter < RAIN_SKIP_MM,
            note:
                rainAfter >= RAIN_SKIP_MM
                    ? `kiša ${round(rainAfter)} mm u naredna ${RAIN_AFTER_HOURS} h`
                    : `ET0 ${round(evap)} mm/h`,
            loss: evap,
        };
    };

    const candidates = candidateTimes.map((t) => evaluate(t, []));

    const tempsInWindow = f.hourly
        .filter((p) => p.at >= nowMs && p.at < windowEnd)
        .map((p) => p.temperature);

    const windowLabel = `${localTime(nowMs, offset)} - ${localTime(windowEnd, offset)}`;

    const base = {
        windowStart: new Date(nowMs).toISOString(),
        windowEnd: new Date(windowEnd).toISOString(),
        windowLabel,
        deficitMm: round(deficit),
        deficitEndWindowMm: round(deficitEnd),
        rawMm: round(raw),
        tawMm: round(taw),
        etcWindowMm: round(et0Between(f, nowMs, windowEnd) * kc),
        rainWindowMm: round(rainBetween(f, nowMs, windowEnd)),
        maxTempWindow: tempsInWindow.length
            ? round(Math.max(...tempsInWindow))
            : null,
        source: (moisture !== null
            ? "sensor"
            : "water_balance") as Fao56Decision["source"],
        urgent,
        slots: candidates.map((c) => ({
            at: new Date(c.at).toISOString(),
            label: c.label,
            valid: c.valid,
            note: c.note,
        })),
    };

    const skip = (reason: string): Fao56Decision => ({
        ...base,
        shouldIrrigate: false,
        totalMinutes: 0,
        plan: [],
        deficitEndWithPlanMm: round(deficitEnd),
        reason,
    });

    // 3. Treba li zalijevati u ovom periodu?
    if (!urgent && deficitEnd < raw) {
        const rain = base.rainWindowMm;
        return skip(
            `U periodu ${windowLabel} deficit ostaje ispod praga ` +
            `(${round(deficitEnd)} / ${round(raw)} mm)` +
            (rain >= 2 ? `, očekivana kiša ${rain} mm.` : ".")
        );
    }

    // Termin mora biti prije nego deficit pređe prag (prvi uvijek dolazi u
    // obzir). Kad je tlo već suho, svaki termin u periodu (npr. poslije kiše).
    const valid = candidates.filter(
        (c, i) =>
            c.valid &&
            c.minutes >= MIN_MINUTES &&
            (urgent || i === 0 || c.at <= crossing)
    );

    if (valid.length === 0) {
        return skip(
            `U periodu ${windowLabel} očekuje se kiša koja će nadoknaditi vodu - zalijevanje nije potrebno.`
        );
    }

    const main = urgent
        ? valid[0]
        : valid.reduce((best, c) => (c.loss < best.loss ? c : best));

    const plan: PlannedCycle[] = [];
    const irrigations: Irrigation[] = [];

    const addCycle = (at: number, minutes: number, purpose: string) => {
        plan.push({
            at: new Date(at).toISOString(),
            label: localTime(at, offset),
            minutes,
            purpose,
            status: "planned",
            note: null,
            commandId: null,
        });
        irrigations.push({ at, mm: minutes * mmPerMinute });
    };

    addCycle(
        main.at,
        main.minutes,
        urgent
            ? "tlo je već ispod praga - najraniji termin bez kiše"
            : "najmanje isparavanja prije nego tlo pređe prag"
    );

    // 4. Nastavak kad jedno zalijevanje (max_minutes) nije dovoljno.
    let next = main.at + (main.minutes + SOAK_MINUTES) * 60_000;
    let previousCapped = main.neededMinutes > maxMinutes;

    while (previousCapped && plan.length < MAX_CYCLES && next < windowEnd) {
        const c = evaluate(next, irrigations);
        if (!c.valid || c.minutes < MIN_MINUTES) break;

        previousCapped = c.neededMinutes > maxMinutes;
        addCycle(next, c.minutes, `nastavak - jedno zalijevanje je ograničeno na ${maxMinutes} min`);
        next += (c.minutes + SOAK_MINUTES) * 60_000;
    }

    const totalMinutes = plan.reduce((sum, c) => sum + c.minutes, 0);

    return {
        ...base,
        shouldIrrigate: true,
        totalMinutes,
        plan,
        deficitEndWithPlanMm: round(deficitAt(windowEnd, irrigations)),
        reason:
            (urgent
                ? `Tlo je već ispod praga (deficit ${round(deficit)} / ${round(raw)} mm). `
                : `Do ${localTime(crossing, offset)} deficit prelazi prag (${round(raw)} mm). `) +
            `Plan za ${windowLabel}: ${plan.length} zalijevanje/a, ukupno ${totalMinutes} min.`,
    };
}

export function shouldSkipBeforeStart(
    s: Fao56Settings,
    moisture: number,
    plannedMinutes: number
) {
    const deficitNow = deficitFromMoisture(s, moisture);
    const plannedMm = plannedMinutes * Number(s.mm_per_minute);

    // Manje od trećine planirane vode još fali -> nema smisla zalijevati.
    return deficitNow < plannedMm / 3;
}

/** Novi mm/min iz jednog zalijevanja (eksponencijalni prosjek). */
export function learnMmPerMinute(
    s: Fao56Settings,
    moistureBefore: number,
    moistureAfter: number,
    minutes: number
): number | null {
    if (minutes <= 0 || moistureAfter <= moistureBefore) {
        return null;
    }

    const measured =
        moistureDeltaToMm(s, moistureAfter - moistureBefore) / minutes;

    if (!Number.isFinite(measured) || measured <= 0) {
        return null;
    }

    const next =
        s.calibrations === 0
            ? measured
            : Number(s.mm_per_minute) * 0.7 + measured * 0.3;

    const rounded = Math.round(next * 10000) / 10000;
    return rounded > 0 ? rounded : null;
}
