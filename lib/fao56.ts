/*
 * FAO-56 vodni bilans tla (Allen et al., FAO Irrigation and Drainage Paper 56).
 *
 *   deficit = deficit + ET0 * Kc - efektivna kiša - navodnjavanje
 *
 * Model se pokreće JEDNOM dnevno, uveče (20:00), i pravi PLAN od 0-3
 * zalijevanja za večeras i sutra:
 *   1. trenutni deficit iz senzora vlage (ili vodnog bilansa ako nema očitanja)
 *   2. satna simulacija deficita do kraja sutrašnjeg dana (ET0, kiša)
 *   3. glavno zalijevanje: večeras 21-23h ili sutra 04-07h
 *      - termin s kišom u narednih 6 h se preskače
 *      - tlo već ispod praga -> najraniji slobodni termin
 *      - inače termin s najmanjim isparavanjem; jutro ima prednost
 *   4. ako treba više od max_minutes -> dodatni ciklus nakon pauze
 *   5. ako bi deficit sutra popodne ponovo prešao prag (vruć dan) ->
 *      dodatno zalijevanje sutra 16-18h
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
    last_run_date: string | null;
    max_minutes: number; // najviše minuta po jednom zalijevanju
    plan: PlannedCycle[] | null;
};

export type PlannedCycle = {
    at: string; // ISO (UTC)
    label: string; // npr. "sutra 05:00"
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
    dates: string[]; // [0] danas, [1] sutra (lokalno)
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
    deficitMm: number; // deficit sada
    deficitEndTomorrowMm: number; // bez zalijevanja
    deficitEndWithPlanMm: number; // sa planom
    rawMm: number; // prag
    tawMm: number;
    etcRestMm: number; // ETc od sada do kraja sutrašnjeg dana
    rainTonightMm: number;
    rainTomorrowMm: number;
    maxTempTomorrow: number | null;
    source: "sensor" | "water_balance";
    urgent: boolean;
    slots: SlotOption[];
    reason: string;
};

export const MIN_MINUTES = 2;
export const MAX_CYCLES = 3;

const EVENING_HOURS = [21, 22, 23]; // večeras
const MORNING_HOURS = [4, 5, 6, 7]; // sutra ujutro
const AFTERNOON_HOURS = [16, 17, 18]; // sutra popodne (samo vrući dani)

const RAIN_AFTER_HOURS = 6; // kiša u ovom periodu nakon termina ...
const RAIN_SKIP_MM = 2; // ... veća od ovoga čini termin nepotrebnim
const SOAK_MINUTES = 45; // pauza između dva uzastopna ciklusa
const HORIZON_HOURS = 28; // od 20h do kraja sutrašnjeg dana

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
        `&daily=et0_fao_evapotranspiration` +
        `&past_days=0&forecast_days=3&timezone=auto`;

    const res = await fetch(url, { cache: "no-store" });

    if (!res.ok) {
        throw new Error(`Open-Meteo error ${res.status}`);
    }

    const json = await res.json();
    const offset = Number(json.utc_offset_seconds ?? 0);
    const h = json.hourly;

    if (!h || !Array.isArray(h.time) || !json.daily?.time?.length) {
        throw new Error("Open-Meteo returned incomplete data");
    }

    const hourly: HourlyPoint[] = h.time.map((t: string, i: number) => ({
        at: localIsoToUtcMs(t, offset),
        et0: h.et0_fao_evapotranspiration[i] ?? 0,
        rain: h.precipitation[i] ?? 0,
        temperature: h.temperature_2m[i] ?? 0,
    }));

    return { dates: json.daily.time, utcOffsetSeconds: offset, hourly };
}

/** "2026-11-08T21:00" (lokalno) -> UTC ms */
function localIsoToUtcMs(local: string, offsetSeconds: number) {
    const [date, time = "00:00"] = local.split("T");
    const [y, m, d] = date.split("-").map(Number);
    const [hr, min] = time.split(":").map(Number);
    return Date.UTC(y, m - 1, d, hr, min) - offsetSeconds * 1000;
}

/** Lokalni datum "YYYY-MM-DD" + sat -> UTC ms */
function localHourToUtcMs(date: string, hour: number, offsetSeconds: number) {
    const [y, m, d] = date.split("-").map(Number);
    return Date.UTC(y, m - 1, d, hour) - offsetSeconds * 1000;
}

/** Lokalni datum ("YYYY-MM-DD") i sat za UTC ms. */
function localParts(ms: number, offsetSeconds: number) {
    const local = new Date(ms + offsetSeconds * 1000);
    return {
        date: local.toISOString().slice(0, 10),
        hour: local.getUTCHours(),
        minute: local.getUTCMinutes(),
    };
}

/** Oznaka termina u odnosu na trenutak pokretanja: "večeras 21:00", "sutra 05:00"... */
function slotLabel(ms: number, nowMs: number, offsetSeconds: number) {
    const t = localParts(ms, offsetSeconds);
    const now = localParts(nowMs, offsetSeconds);
    const tomorrow = localParts(nowMs + 24 * 3600_000, offsetSeconds).date;
    const time = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;

    if (t.date === now.date) {
        return `${t.hour >= 18 ? "večeras" : "danas"} ${time}`;
    }

    if (t.date === tomorrow) {
        return `sutra ${time}`;
    }

    return `${t.date} ${time}`;
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

    // Vremenski okvir računamo od trenutka pokretanja, pa model radi
    // ispravno bez obzira na to kada je cron pokrenut (20h, ponoć...).
    const nowLocal = localParts(nowMs, offset);
    const startToday = localHourToUtcMs(nowLocal.date, 0, offset);
    const midnight = localHourToUtcMs(nowLocal.date, 24, offset);
    const endTomorrow = nowMs + HORIZON_HOURS * 3600_000;

    // 1. Deficit sada.
    const deficit =
        moisture !== null
            ? deficitFromMoisture(s, moisture)
            : simulate(s, f, Number(s.deficit_mm), startToday, nowMs, []);

    const deficitAt = (t: number, irrigations: Irrigation[]) =>
        simulate(s, f, deficit, nowMs, t, irrigations);

    const deficitEnd = deficitAt(endTomorrow, []);
    const urgent = deficit >= raw;

    // Kandidat termin: deficit u tom trenutku i kiša nakon njega.
    const evaluate = (at: number, label: string, irrigations: Irrigation[]) => {
        const rainAfter = rainBetween(f, at, at + RAIN_AFTER_HOURS * 3600_000);
        const depletion = deficitAt(at, irrigations);
        const neededMinutes = Math.round(depletion / mmPerMinute);

        return {
            at,
            label,
            depletion,
            neededMinutes,
            minutes: Math.min(neededMinutes, maxMinutes),
            valid: rainAfter < RAIN_SKIP_MM,
            note:
                rainAfter >= RAIN_SKIP_MM
                    ? `kiša ${round(rainAfter)} mm u narednih ${RAIN_AFTER_HOURS} h`
                    : `ET0 u terminu ${round(et0Between(f, at, at + 2 * 3600_000))} mm`,
            // Isparavanje oko termina; večer blago kažnjena (jutro ima prednost).
            loss:
                et0Between(f, at, at + 2 * 3600_000) +
                (localParts(at, offset).hour >= 18 ? 0.05 : 0),
        };
    };

    // 2. Glavni termin: večeras ili sutra ujutro.
    // Večernji i jutarnji termini u narednih 24 h.
    const mainCandidates = f.hourly
        .filter((p) => {
            if (p.at <= nowMs || p.at > nowMs + 24 * 3600_000) return false;
            const hour = localParts(p.at, offset).hour;
            return EVENING_HOURS.includes(hour) || MORNING_HOURS.includes(hour);
        })
        .map((p) => evaluate(p.at, slotLabel(p.at, nowMs, offset), []));

    const tonightRain = rainBetween(f, nowMs, midnight);
    const tomorrowRain = rainBetween(f, midnight, midnight + 24 * 3600_000);
    const tomorrowTemps = f.hourly
        .filter((p) => p.at >= midnight && p.at < midnight + 24 * 3600_000)
        .map((p) => p.temperature);

    const slots: SlotOption[] = mainCandidates.map((c) => ({
        at: new Date(c.at).toISOString(),
        label: c.label,
        valid: c.valid,
        note: c.note,
    }));

    const base = {
        deficitMm: round(deficit),
        deficitEndTomorrowMm: round(deficitEnd),
        rawMm: round(raw),
        tawMm: round(taw),
        etcRestMm: round(et0Between(f, nowMs, endTomorrow) * kc),
        rainTonightMm: round(tonightRain),
        rainTomorrowMm: round(tomorrowRain),
        maxTempTomorrow: tomorrowTemps.length
            ? round(Math.max(...tomorrowTemps))
            : null,
        source: (moisture !== null
            ? "sensor"
            : "water_balance") as Fao56Decision["source"],
        urgent,
        slots,
    };

    const skip = (reason: string): Fao56Decision => ({
        ...base,
        shouldIrrigate: false,
        totalMinutes: 0,
        plan: [],
        deficitEndWithPlanMm: round(deficitEnd),
        reason,
    });

    if (deficitEnd < raw) {
        return skip(
            `Do kraja sutrašnjeg dana deficit će biti ${round(deficitEnd)} mm, ispod praga ${round(raw)} mm` +
            (tonightRain + tomorrowRain >= 2
                ? ` (očekivana kiša ${round(tonightRain + tomorrowRain)} mm).`
                : ".")
        );
    }

    const validMain = mainCandidates.filter(
        (c) => c.valid && c.minutes >= MIN_MINUTES
    );

    if (validMain.length === 0) {
        return skip(
            "Svi termini večeras i sutra ujutro imaju kišu u narednih nekoliko sati - zalijevanje nije potrebno."
        );
    }

    const main = urgent
        ? validMain[0]
        : validMain.reduce((best, c) => (c.loss < best.loss ? c : best));

    const plan: PlannedCycle[] = [];
    const irrigations: Irrigation[] = [];

    const addCycle = (at: number, label: string, minutes: number, purpose: string) => {
        plan.push({
            at: new Date(at).toISOString(),
            label,
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
        main.label,
        main.minutes,
        urgent
            ? "tlo je već ispod praga - najraniji termin bez kiše"
            : localParts(main.at, offset).hour >= 18
                ? "najmanje isparavanja, bez kiše nakon termina"
                : "jutro bez kiše, voda dostupna prije dnevne vrućine"
    );

    // 3. Ostatak potrebne vode u dodatnim ciklusima (nakon pauze) - samo
    //    kad prethodni ciklus nije mogao dati svu vodu zbog max_minutes.
    let next = main.at + (main.minutes + SOAK_MINUTES) * 60_000;
    let previousCapped = main.neededMinutes > maxMinutes;

    while (previousCapped && plan.length < MAX_CYCLES) {
        const c = evaluate(next, "", irrigations);
        if (!c.valid || c.minutes < MIN_MINUTES) break;

        previousCapped = c.neededMinutes > maxMinutes;

        const label = slotLabel(next, nowMs, offset);

        addCycle(next, label, c.minutes, "nastavak - jedno zalijevanje je ograničeno na " + maxMinutes + " min");
        next += (c.minutes + SOAK_MINUTES) * 60_000;
    }

    // 4. Vruć dan: da li deficit sutra popodne ponovo prelazi prag?
    if (plan.length < MAX_CYCLES) {
        const afternoon = f.hourly.filter(
            (p) =>
                p.at > next &&
                p.at < endTomorrow &&
                AFTERNOON_HOURS.includes(localParts(p.at, offset).hour)
        );

        for (const p of afternoon) {
            const at = p.at;
            const c = evaluate(at, slotLabel(at, nowMs, offset), irrigations);

            if (c.depletion >= raw && c.valid && c.minutes >= MIN_MINUTES) {
                addCycle(at, c.label, c.minutes, "deficit sutra popodne ponovo prelazi prag (vruć dan)");
                break;
            }
        }
    }

    const totalMinutes = plan.reduce((sum, c) => sum + c.minutes, 0);
    const capped = main.neededMinutes > maxMinutes && plan.length === 1;

    return {
        ...base,
        shouldIrrigate: true,
        totalMinutes,
        plan,
        deficitEndWithPlanMm: round(deficitAt(endTomorrow, irrigations)),
        reason:
            `Do kraja sutrašnjeg dana deficit bi bio ${round(deficitEnd)} mm (prag ${round(raw)} mm). ` +
            `Plan: ${plan.length} zalijevanje/a, ukupno ${totalMinutes} min.` +
            (capped
                ? ` Potrebno ${main.neededMinutes} min, zalijeva se ${main.minutes} min (ograničenje po zalijevanju).`
                : ""),
    };
}

/**
 * Provjera neposredno prije ciklusa: ako je tlo u međuvremenu dobilo
 * vodu (npr. kiša), ciklus se preskače.
 */
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
