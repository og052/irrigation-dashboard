/*
 * FAO-56 vodni bilans tla (Allen et al., FAO Irrigation and Drainage Paper 56).
 *
 *   deficit = jučerašnji deficit + ET0 * Kc - efektivna kiša - navodnjavanje
 *
 * - ET0 i kišu daje Open-Meteo (et0_fao_evapotranspiration, precipitation_sum).
 * - Kad postoji svježe očitanje senzora, deficit se računa direktno iz vlage,
 *   pa model ne može "odlutati".
 * - Protok vode nije poznat, pa se mm -> minute uči iz senzora:
 *   koliko mm vode tlo dobije po minuti zalijevanja (mm_per_minute).
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
    last_run_date: string | null;
};

export type Forecast = {
    dates: string[]; // [0] jučer, [1] danas, [2] sutra
    et0: number[]; // mm/dan
    rain: number[]; // mm/dan
};

export type Fao56Decision = {
    shouldIrrigate: boolean;
    durationMinutes: number;
    deficitMm: number; // deficit sada
    deficitAfterMm: number; // deficit nakon zalijevanja
    rawMm: number; // prag (readily available water)
    tawMm: number; // ukupno raspoloživa voda
    et0Today: number;
    etcToday: number;
    rainTodayMm: number;
    rainTomorrowMm: number;
    source: "sensor" | "water_balance";
    reason: string;
};

export const MIN_MINUTES = 2;
export const MAX_MINUTES = 30;

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
        `&daily=et0_fao_evapotranspiration,precipitation_sum` +
        `&past_days=1&forecast_days=2&timezone=auto`;

    const res = await fetch(url, { cache: "no-store" });

    if (!res.ok) {
        throw new Error(`Open-Meteo error ${res.status}`);
    }

    const daily = (await res.json()).daily;

    if (!daily || !Array.isArray(daily.time) || daily.time.length < 3) {
        throw new Error("Open-Meteo returned incomplete daily data");
    }

    return {
        dates: daily.time,
        et0: daily.et0_fao_evapotranspiration.map(
            (v: number | null) => v ?? 0
        ),
        rain: daily.precipitation_sum.map((v: number | null) => v ?? 0),
    };
}

/** Male kiše (<2 mm) uglavnom ispare; od veće ~80% uđe u tlo. */
export function effectiveRain(mm: number) {
    return mm < 2 ? 0 : mm * 0.8;
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

export function decide(
    s: Fao56Settings,
    moisture: number | null,
    f: Forecast
): Fao56Decision {
    const kc = Number(s.kc);
    const taw = totalAvailableWater(s);
    const raw = Number(s.p) * taw;

    // 1. Trenutni deficit: senzor ako postoji, inače vodni bilans od jučer.
    const deficit =
        moisture !== null
            ? deficitFromMoisture(s, moisture)
            : clamp(
                  Number(s.deficit_mm) + f.et0[0] * kc - effectiveRain(f.rain[0]),
                  0,
                  taw
              );

    // 2. Projekcija do kraja dana.
    const etcToday = f.et0[1] * kc;
    const peToday = effectiveRain(f.rain[1]);
    const peTomorrow = effectiveRain(f.rain[2]);
    const deficitEndOfDay = clamp(deficit + etcToday - peToday, 0, taw);

    const base = {
        deficitMm: round(deficit),
        rawMm: round(raw),
        tawMm: round(taw),
        et0Today: round(f.et0[1]),
        etcToday: round(etcToday),
        rainTodayMm: round(f.rain[1]),
        rainTomorrowMm: round(f.rain[2]),
        source: (moisture !== null
            ? "sensor"
            : "water_balance") as Fao56Decision["source"],
    };

    if (deficitEndOfDay < raw) {
        return {
            ...base,
            shouldIrrigate: false,
            durationMinutes: 0,
            deficitAfterMm: base.deficitMm,
            reason: `Deficit ${round(deficitEndOfDay)} mm do kraja dana je ispod praga ${round(raw)} mm.`,
        };
    }

    if (peTomorrow >= deficitEndOfDay * 0.5) {
        return {
            ...base,
            shouldIrrigate: false,
            durationMinutes: 0,
            deficitAfterMm: base.deficitMm,
            reason: `Sutra se očekuje ${round(f.rain[2])} mm kiše.`,
        };
    }

    // 3. Vrati tlo na poljski kapacitet: mm -> minute (naučeno).
    const minutes = Math.round(deficit / Number(s.mm_per_minute));
    const duration = clamp(minutes, MIN_MINUTES, MAX_MINUTES);
    const appliedMm = duration * Number(s.mm_per_minute);

    return {
        ...base,
        shouldIrrigate: true,
        durationMinutes: duration,
        deficitAfterMm: round(clamp(deficit - appliedMm, 0, taw)),
        reason: `Deficit ${round(deficitEndOfDay)} mm do kraja dana je iznad praga ${round(raw)} mm.`,
    };
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
