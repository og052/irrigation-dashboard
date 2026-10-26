"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export type IrrigationPeriod = {
    id: string;
    started_at: string;
    ended_at: string | null;
};

const REFRESH_MS = 30000;

type Options = {
    sensorId?: string | null;
    sensorCode?: string | null;
    /*
     * How many days back to load, counting today.
     * days=1 -> just today, days=30 -> last 30 days.
     * Fetch the widest range you'll ever need once; the chart's
     * range buttons then just filter this client-side, with no
     * extra network round trip per button click.
     */
    days?: number;
};

/*
 * Returns completed irrigations for a sensor over the last
 * `days` days (default 30). Pass either sensorId or sensorCode.
 */
export function useIrrigations({
    sensorId,
    sensorCode,
    days = 30,
}: Options): IrrigationPeriod[] {
    const [periods, setPeriods] = useState<IrrigationPeriod[]>([]);

    useEffect(() => {
        setPeriods([]);

        if (!sensorId && !sensorCode) return;

        let cancelled = false;
        let resolvedId: string | null = sensorId ?? null;

        async function resolveSensorId(): Promise<string | null> {
            if (resolvedId) return resolvedId;

            const { data, error } = await supabase
                .from("sensors")
                .select("id")
                .eq("sensor_code", sensorCode as string)
                .maybeSingle();

            if (error) {
                console.error(
                    "Error loading sensor:",
                    error.message,
                    error.code,
                    error.details
                );
                return null;
            }

            if (!data) {
                console.error(
                    `No sensor found for sensor_code "${sensorCode}".`
                );
                return null;
            }

            resolvedId = data.id;
            return resolvedId;
        }

        async function refresh() {
            if (document.hidden) return;

            const id = await resolveSensorId();

            if (!id) return;

            const rangeStart = new Date();
            rangeStart.setHours(0, 0, 0, 0);
            rangeStart.setDate(rangeStart.getDate() - (days - 1));

            const fromIso = rangeStart.toISOString();

            const { data, error } = await supabase
                .from("irrigation_history")
                .select("id, started_at, ended_at")
                .eq("sensor_id", id)
                .eq("status", "completed")
                .or(`ended_at.gte.${fromIso},ended_at.is.null`)
                .order("started_at", { ascending: true });

            if (error) {
                console.error(
                    "Error loading irrigation history:",
                    error.message,
                    error.code,
                    error.details
                );
                return;
            }

            if (!cancelled) {
                setPeriods((data ?? []) as IrrigationPeriod[]);
            }
        }

        refresh();

        const interval = setInterval(refresh, REFRESH_MS);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [sensorId, sensorCode, days]);

    return periods;
}

/*
 * Backwards-compatible alias for existing call sites -
 * same as useIrrigations({ ...options, days: 1 }).
 */
export function useTodayIrrigations(
    options: Omit<Options, "days">
): IrrigationPeriod[] {
    return useIrrigations({ ...options, days: 1 });
}