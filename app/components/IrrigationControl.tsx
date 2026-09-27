"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type IrrigationMode = "manual" | "automatic" | "intelligent";
type AutomaticSubMode = "moisture" | "schedule";
type WeekDay = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
type ActiveStrategy = "none" | "moisture" | "schedule" | "intelligent";

type CommandStatus =
    | "pending"
    | "sent"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled";

type IrrigationCommand = {
    id: string;
    command_type: "start_irrigation" | "stop_irrigation";
    duration_minutes: number | null;
    source: string;
    status: CommandStatus;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
};

/*
 * A finished irrigation, as recorded in irrigation_history
 * once it actually ran (independent of the command that
 * triggered it).
 */
type HistoryRecord = {
    id: string;
    mode: string;
    duration: number;
    started_at: string;
    ended_at: string | null;
};

/*
 * current  = the most recent irrigation command (any status),
 *            from irrigation_commands
 * previous = the most recent completed irrigation,
 *            from irrigation_history
 */
type CommandOverview = {
    current: IrrigationCommand | null;
    previous: HistoryRecord | null;
};

const EMPTY_COMMAND_OVERVIEW: CommandOverview = {
    current: null,
    previous: null,
};

type Schedule = {
    id: string;
    time: string;
    durationMinutes: number;
    days: WeekDay[];
    enabled: boolean;
};

type ScheduleRow = {
    id: string;
    start_time: string;
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

const WEEK_DAYS: WeekDay[] = [
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
    "Sun",
];

const SCHEDULE_COLUMNS = `
    id,
    start_time,
    duration_minutes,
    monday,
    tuesday,
    wednesday,
    thursday,
    friday,
    saturday,
    sunday,
    enabled
`;

const COMMAND_COLUMNS = `
    id,
    command_type,
    duration_minutes,
    source,
    status,
    created_at,
    started_at,
    completed_at
`;

const HISTORY_COLUMNS = `
    id,
    mode,
    duration,
    started_at,
    ended_at
`;

const COMMAND_POLL_INTERVAL_MS = 5000;

const STRATEGY_LABELS = {
    moisture: "By moisture",
    schedule: "By schedule",
    intelligent: "Intelligent",
} as const;

/*
 * Maps a database row from irrigation_schedules
 * to the Schedule shape used by the UI.
 */
function mapScheduleRow(row: ScheduleRow): Schedule {
    const days: WeekDay[] = [];

    if (row.monday) days.push("Mon");
    if (row.tuesday) days.push("Tue");
    if (row.wednesday) days.push("Wed");
    if (row.thursday) days.push("Thu");
    if (row.friday) days.push("Fri");
    if (row.saturday) days.push("Sat");
    if (row.sunday) days.push("Sun");

    return {
        id: row.id,
        time: row.start_time.slice(0, 5),
        durationMinutes: row.duration_minutes,
        days,
        enabled: row.enabled,
    };
}

/*
 * Loads the current irrigation command (latest, any status)
 * from irrigation_commands, and the most recent completed
 * irrigation from irrigation_history, for one sensor.
 *
 * These come from two independent tables: "current" is
 * whatever the app last asked the device to do, "previous" is
 * the last irrigation the device actually finished.
 *
 * Returns undefined if a request failed, so the caller can
 * keep showing the old data instead of clearing it.
 */
async function fetchCommandOverview(
    sensorId: string
): Promise<CommandOverview | undefined> {
    const [latest, lastHistory] = await Promise.all([
        supabase
            .from("irrigation_commands")
            .select(COMMAND_COLUMNS)
            .eq("sensor_id", sensorId)
            .eq("command_type", "start_irrigation")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),

        supabase
            .from("irrigation_history")
            .select(HISTORY_COLUMNS)
            .eq("sensor_id", sensorId)
            .eq("status", "completed")
            .order("started_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
    ]);

    if (latest.error || lastHistory.error) {
        console.error(
            "Error loading irrigation overview:",
            latest.error ?? lastHistory.error
        );
        return undefined;
    }

    return {
        current: latest.data as IrrigationCommand | null,
        previous: lastHistory.data as HistoryRecord | null,
    };
}

type Props = {
    sensorCode: string;
    moisture: number;
};

export default function IrrigationControl({
    sensorCode,
    moisture,
}: Props) {
    const [mode, setMode] =
        useState<IrrigationMode>("manual");

    const [automaticSubMode, setAutomaticSubMode] =
        useState<AutomaticSubMode>("moisture");

    /*
     * The ONE strategy that is currently enabled.
     * Because this is a single value, only one strategy
     * can be enabled at a time.
     */
    const [activeStrategy, setActiveStrategy] =
        useState<ActiveStrategy>("none");

    const [duration, setDuration] = useState(5);
    const [threshold, setThreshold] = useState(40);

    /*
     * How long to irrigate for when the "by moisture" strategy
     * triggers. Kept separate from "duration" above, which is
     * only for a manual Start click - otherwise editing one
     * would silently change the other.
     */
    const [moistureDuration, setMoistureDuration] = useState(5);

    const [schedules, setSchedules] =
        useState<Schedule[]>([]);

    const [newTime, setNewTime] = useState("08:00");

    const [newDurationMinutes, setNewDurationMinutes] =
        useState(15);

    const [newDays, setNewDays] = useState<WeekDay[]>([]);

    const [irrigationSettingId, setIrrigationSettingId] =
        useState<string | null>(null);

    const [sensorId, setSensorId] =
        useState<string | null>(null);

    const [commandOverview, setCommandOverview] =
        useState<CommandOverview>(EMPTY_COMMAND_OVERVIEW);

    /*
     * True while there is a start command that hasn't finished
     * yet ("pending" / "sent" / "executing"). Used to block
     * sending a second Start while one is already in flight -
     * the DB has a matching unique index as a backstop, but
     * disabling the button avoids that error reaching the user.
     */
    const hasActiveCommand = [
        "pending",
        "sent",
        "executing",
    ].includes(commandOverview.current?.status ?? "");

    /*
     * The valve is actually open only once the device reports
     * "executing". "pending" / "sent" mean the command hasn't
     * started running yet, so the valve is still closed.
     */
    const isIrrigating =
        commandOverview.current?.status === "executing";

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [starting, setStarting] = useState(false);
    const [cancelling, setCancelling] = useState(false);

    /*
     * ---------------------------------------------------------
     * LOAD SETTINGS
     * ---------------------------------------------------------
     */

    useEffect(() => {
        loadIrrigationSettings();
    }, [sensorCode]);

    async function loadIrrigationSettings() {
        setLoading(true);

        /*
         * Reset anything that belongs to the previous sensor.
         */
        setSensorId(null);
        setCommandOverview(EMPTY_COMMAND_OVERVIEW);

        try {
            /*
             * 1. Find sensor by sensor code
             */

            const { data: sensor, error: sensorError } =
                await supabase
                    .from("sensors")
                    .select("id")
                    .eq("sensor_code", sensorCode)
                    .single();

            if (sensorError) {
                console.error(
                    "Error loading sensor:",
                    sensorError
                );
                return;
            }

            setSensorId(sensor.id);

            /*
             * 2. Make sure a settings row exists.
             * ignoreDuplicates = do nothing if it already
             * exists, so concurrent calls (React Strict Mode)
             * never fail and never overwrite existing data.
             */

            const { error: ensureError } = await supabase
                .from("irrigation_settings")
                .upsert(
                    {
                        sensor_id: sensor.id,
                        mode: "manual",
                        automatic_strategy: "moisture",
                        active_strategy: "none",
                    },
                    {
                        onConflict: "sensor_id",
                        ignoreDuplicates: true,
                    }
                );

            if (ensureError) {
                console.error(
                    "Error creating irrigation settings:",
                    ensureError.message
                );
                return;
            }

            /*
             * 3. Load irrigation settings
             */

            const { data: settings, error: settingsError } =
                await supabase
                    .from("irrigation_settings")
                    .select(
                        "id, mode, automatic_strategy, active_strategy"
                    )
                    .eq("sensor_id", sensor.id)
                    .single();

            if (settingsError) {
                console.error(
                    "Error loading irrigation settings:",
                    settingsError.message
                );
                return;
            }

            setIrrigationSettingId(settings.id);
            setMode(settings.mode as IrrigationMode);

            setAutomaticSubMode(
                settings.automatic_strategy as AutomaticSubMode
            );

            setActiveStrategy(
                settings.active_strategy as ActiveStrategy
            );

            /*
             * 4. Load moisture settings
             */

            const {
                data: moistureSettings,
                error: moistureError,
            } = await supabase
                .from("irrigation_moisture_settings")
                .select("threshold, duration_minutes")
                .eq("irrigation_setting_id", settings.id)
                .maybeSingle();

            if (moistureError) {
                console.error(
                    "Error loading moisture settings:",
                    moistureError
                );
            }

            if (moistureSettings) {
                setThreshold(Number(moistureSettings.threshold));

                setMoistureDuration(
                    Number(moistureSettings.duration_minutes)
                );
            }

            /*
             * 5. Load schedules
             */

            const {
                data: scheduleData,
                error: scheduleError,
            } = await supabase
                .from("irrigation_schedules")
                .select(SCHEDULE_COLUMNS)
                .eq("irrigation_setting_id", settings.id)
                .order("start_time", { ascending: true });

            if (scheduleError) {
                console.error(
                    "Error loading schedules:",
                    scheduleError
                );
            }

            if (scheduleData) {
                setSchedules(
                    (scheduleData as ScheduleRow[]).map(
                        mapScheduleRow
                    )
                );
            }
        } catch (error) {
            console.error(
                "Unexpected irrigation settings error:",
                error
            );
        } finally {
            setLoading(false);
        }
    }

    /*
     * ---------------------------------------------------------
     * COMMAND OVERVIEW (auto refresh every 5 seconds)
     *
     * Runs whenever the selected sensor changes. The interval
     * is cleared on cleanup, and the "cancelled" flag makes sure
     * a slow response for a previous sensor is never applied.
     * ---------------------------------------------------------
     */

    useEffect(() => {
        if (!sensorId) return;

        const currentSensorId = sensorId;
        let cancelled = false;

        async function refresh() {
            /*
             * No need to poll while the browser tab is hidden.
             */
            if (document.hidden) return;

            const overview = await fetchCommandOverview(
                currentSensorId
            );

            if (!cancelled && overview !== undefined) {
                setCommandOverview(overview);
            }
        }

        refresh();

        const interval = setInterval(
            refresh,
            COMMAND_POLL_INTERVAL_MS
        );

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [sensorId]);

    async function refreshCommandOverview() {
        if (!sensorId) return;

        const overview = await fetchCommandOverview(sensorId);

        if (overview !== undefined) {
            setCommandOverview(overview);
        }
    }

    /*
     * ---------------------------------------------------------
     * ACTIVE STRATEGY (enable / disable)
     *
     * Clicking the active strategy disables it ("none").
     * Clicking any other strategy enables it, which
     * automatically disables the previous one.
     * ---------------------------------------------------------
     */

    async function toggleStrategy(
        strategy: Exclude<ActiveStrategy, "none">
    ) {
        if (!irrigationSettingId) return;

        const previous = activeStrategy;

        const next: ActiveStrategy =
            previous === strategy ? "none" : strategy;

        setActiveStrategy(next);

        const { error } = await supabase
            .from("irrigation_settings")
            .update({ active_strategy: next })
            .eq("id", irrigationSettingId);

        if (error) {
            console.error(
                "Error updating active strategy:",
                error
            );

            setActiveStrategy(previous);
        }
    }

    /*
     * ---------------------------------------------------------
     * MODE
     * ---------------------------------------------------------
     */

    async function changeMode(newMode: IrrigationMode) {
        setMode(newMode);

        if (!irrigationSettingId) return;

        const { error } = await supabase
            .from("irrigation_settings")
            .update({ mode: newMode })
            .eq("id", irrigationSettingId);

        if (error) {
            console.error("Error updating irrigation mode:", error);
        }
    }

    /*
     * ---------------------------------------------------------
     * AUTOMATIC STRATEGY (which tab is selected)
     * ---------------------------------------------------------
     */

    async function changeAutomaticStrategy(
        strategy: AutomaticSubMode
    ) {
        setAutomaticSubMode(strategy);

        if (!irrigationSettingId) return;

        const { error } = await supabase
            .from("irrigation_settings")
            .update({ automatic_strategy: strategy })
            .eq("id", irrigationSettingId);

        if (error) {
            console.error(
                "Error updating automatic strategy:",
                error
            );
        }
    }

    /*
     * ---------------------------------------------------------
     * MOISTURE SETTINGS
     * ---------------------------------------------------------
     */

    async function saveMoistureSettings() {
        if (!irrigationSettingId) return;

        setSaving(true);

        const { error } = await supabase
            .from("irrigation_moisture_settings")
            .upsert(
                {
                    irrigation_setting_id: irrigationSettingId,
                    threshold,
                    duration_minutes: moistureDuration,
                },
                { onConflict: "irrigation_setting_id" }
            );

        if (error) {
            console.error(
                "Error saving moisture settings:",
                error
            );
        }

        setSaving(false);
    }

    /*
     * ---------------------------------------------------------
     * MANUAL IRRIGATION COMMAND
     *
     * The created command is put straight into the status card,
     * so the status updates immediately after the click.
     * ---------------------------------------------------------
     */

    async function startManualIrrigation() {
        if (!sensorId) {
            console.error("Sensor ID is missing.");
            return;
        }

        setStarting(true);

        try {
            const { data, error } = await supabase
                .from("irrigation_commands")
                .insert({
                    sensor_id: sensorId,
                    command_type: "start_irrigation",
                    duration_minutes: duration,
                    source: "manual",
                    status: "pending",
                })
                .select(COMMAND_COLUMNS)
                .single();

            if (error) {
                if (error.code === "23505") {
                    /*
                     * An active command already exists for this
                     * sensor. Show it instead of the new one.
                     */
                    console.warn(
                        "Irrigation is already in progress for this sensor."
                    );
                } else {
                    console.error(
                        "Error creating irrigation command:",
                        error
                    );
                }

                await refreshCommandOverview();
                return;
            }

            const created = data as IrrigationCommand;

            /*
             * The new command becomes "current" right away.
             * "previous" is left as-is: it comes from
             * irrigation_history and updates once the device
             * actually finishes and a history row is written.
             */
            setCommandOverview((prev) => ({
                ...prev,
                current: created,
            }));
        } catch (error) {
            console.error(
                "Unexpected irrigation command error:",
                error
            );
        } finally {
            setStarting(false);
        }
    }

    /*
     * ---------------------------------------------------------
     * CANCEL MANUAL IRRIGATION COMMAND
     *
     * Moves the current command straight to "cancelled",
     * whether it is still "pending" / "sent" (device hasn't
     * picked it up yet) or already "executing". The device
     * side (ESP32 / worker) must also watch for a command
     * flipping to "cancelled" while it is executing, and
     * physically close the valve when that happens.
     * ---------------------------------------------------------
     */

    async function cancelCurrentIrrigation() {
        const current = commandOverview.current;

        if (
            !current ||
            !["pending", "sent", "executing"].includes(
                current.status
            )
        ) {
            return;
        }

        setCancelling(true);

        try {
            const { data, error } = await supabase
                .from("irrigation_commands")
                .update({ status: "cancelled" })
                .eq("id", current.id)
                .select(COMMAND_COLUMNS)
                .single();

            if (error) {
                console.error(
                    "Error cancelling irrigation command:",
                    error
                );

                await refreshCommandOverview();
                return;
            }

            setCommandOverview((prev) => ({
                ...prev,
                current: data as IrrigationCommand,
            }));
        } catch (error) {
            console.error(
                "Unexpected error cancelling irrigation command:",
                error
            );
        } finally {
            setCancelling(false);
        }
    }

    /*
     * ---------------------------------------------------------
     * SCHEDULE DAYS
     * ---------------------------------------------------------
     */

    function toggleNewDay(day: WeekDay) {
        setNewDays((prev) =>
            prev.includes(day)
                ? prev.filter((d) => d !== day)
                : [...prev, day]
        );
    }

    /*
     * ---------------------------------------------------------
     * ADD SCHEDULE
     * ---------------------------------------------------------
     */

    async function addSchedule() {
        if (newDays.length === 0 || !irrigationSettingId) {
            return;
        }

        const { data, error } = await supabase
            .from("irrigation_schedules")
            .insert({
                irrigation_setting_id: irrigationSettingId,
                start_time: newTime,
                duration_minutes: newDurationMinutes,
                monday: newDays.includes("Mon"),
                tuesday: newDays.includes("Tue"),
                wednesday: newDays.includes("Wed"),
                thursday: newDays.includes("Thu"),
                friday: newDays.includes("Fri"),
                saturday: newDays.includes("Sat"),
                sunday: newDays.includes("Sun"),
                enabled: true,
            })
            .select(SCHEDULE_COLUMNS)
            .single();

        if (error) {
            console.error("Error adding schedule:", error);
            return;
        }

        setSchedules((prev) => [
            ...prev,
            mapScheduleRow(data as ScheduleRow),
        ]);

        setNewDays([]);
        setNewDurationMinutes(15);
        setNewTime("08:00");
    }

    /*
     * ---------------------------------------------------------
     * REMOVE SCHEDULE
     * ---------------------------------------------------------
     */

    async function removeSchedule(id: string) {
        const { error } = await supabase
            .from("irrigation_schedules")
            .delete()
            .eq("id", id);

        if (error) {
            console.error("Error removing schedule:", error);
            return;
        }

        setSchedules((prev) =>
            prev.filter((schedule) => schedule.id !== id)
        );
    }

    /*
     * ---------------------------------------------------------
     * ENABLE / DISABLE SINGLE SCHEDULE
     * ---------------------------------------------------------
     */

    async function toggleScheduleEnabled(id: string) {
        const schedule = schedules.find((s) => s.id === id);

        if (!schedule) return;

        const newEnabled = !schedule.enabled;

        const { error } = await supabase
            .from("irrigation_schedules")
            .update({ enabled: newEnabled })
            .eq("id", id);

        if (error) {
            console.error("Error updating schedule:", error);
            return;
        }

        setSchedules((prev) =>
            prev.map((s) =>
                s.id === id ? { ...s, enabled: newEnabled } : s
            )
        );
    }

    /*
     * ---------------------------------------------------------
     * LOADING
     * ---------------------------------------------------------
     */

    if (loading) {
        return (
            <section className="mt-8">
                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                    <p className="text-sm text-slate-500">
                        Loading irrigation settings...
                    </p>
                </div>
            </section>
        );
    }

    return (
        <section className="mt-8">

            {/* HEADER */}

            <div className="mb-5">

                <p className="text-sm font-medium text-slate-500">
                    System control
                </p>

                <h2 className="mt-1 text-2xl font-bold text-slate-900">
                    Irrigation Control
                </h2>

                <p className="mt-1 text-sm text-slate-500">
                    Control irrigation for {sensorCode}.
                </p>

            </div>

            {/* COMMAND STATUS */}

            <CommandStatusCard
                current={commandOverview.current}
                previous={commandOverview.previous}
            />

            {/* MODE SELECTOR */}

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">

                <div className="mb-5">

                    <h3 className="font-semibold text-slate-900">
                        Irrigation mode
                    </h3>

                    <p className="mt-1 text-sm text-slate-500">
                        Select how the irrigation system should operate.
                    </p>

                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">

                    <button
                        onClick={() => changeMode("manual")}
                        className={`rounded-xl border p-4 text-left transition ${mode === "manual"
                            ? "border-blue-500 bg-blue-50"
                            : "border-slate-200 hover:bg-slate-50"
                            }`}
                    >
                        <p className="font-semibold text-slate-900">
                            Manual
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                            Start irrigation manually.
                        </p>
                    </button>

                    <button
                        onClick={() => changeMode("automatic")}
                        className={`rounded-xl border p-4 text-left transition ${mode === "automatic"
                            ? "border-blue-500 bg-blue-50"
                            : "border-slate-200 hover:bg-slate-50"
                            }`}
                    >
                        <p className="font-semibold text-slate-900">
                            Automatic
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                            Irrigate according to moisture or schedule.
                        </p>
                    </button>

                    <button
                        onClick={() => changeMode("intelligent")}
                        className={`rounded-xl border p-4 text-left transition ${mode === "intelligent"
                            ? "border-blue-500 bg-blue-50"
                            : "border-slate-200 hover:bg-slate-50"
                            }`}
                    >
                        <p className="font-semibold text-slate-900">
                            Intelligent
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                            Use prediction and weather data.
                        </p>
                    </button>

                </div>

            </div>

            {/* ACTIVE AUTOMATION BAR */}

            {activeStrategy !== "none" && (
                <div className="mt-4 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 p-4">

                    <p className="text-sm text-emerald-800">
                        Active automation:{" "}
                        <span className="font-semibold">
                            {STRATEGY_LABELS[activeStrategy]}
                        </span>
                    </p>

                    <button
                        onClick={() => toggleStrategy(activeStrategy)}
                        className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100"
                    >
                        Disable
                    </button>

                </div>
            )}

            {/* MANUAL */}

            {mode === "manual" && (
                <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">

                    <h3 className="text-lg font-semibold text-slate-900">
                        Manual irrigation
                    </h3>

                    <p className="mt-1 text-sm text-slate-500">
                        Start irrigation manually for the selected sensor.
                    </p>

                    <div className="mt-5 grid w-full grid-cols-1 gap-5 sm:grid-cols-2">

                        <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-5">

                            <p className="text-sm font-medium text-slate-500">
                                Valve status
                            </p>

                            <div className="mt-4 flex items-center gap-3">

                                <span
                                    className={`h-3 w-3 rounded-full ${isIrrigating
                                        ? "animate-pulse bg-emerald-500"
                                        : "bg-slate-400"
                                        }`}
                                />

                                <span className="text-base font-semibold text-slate-900">
                                    {isIrrigating ? "Open" : "Closed"}
                                </span>

                            </div>

                        </div>

                        <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-5">

                            <p className="text-sm font-medium text-slate-500">
                                Irrigation duration
                            </p>

                            <div className="mt-4 flex items-center gap-4">

                                <button
                                    onClick={() =>
                                        setDuration(
                                            Math.max(1, duration - 1)
                                        )
                                    }
                                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-lg font-medium text-slate-700 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-600"
                                >
                                    −
                                </button>

                                <div className="flex h-10 min-w-[90px] items-center justify-center rounded-lg border border-slate-200 bg-white px-4">

                                    <span className="text-base font-semibold text-slate-900">
                                        {duration}
                                    </span>

                                    <span className="ml-1 text-sm text-slate-500">
                                        min
                                    </span>

                                </div>

                                <button
                                    onClick={() =>
                                        setDuration(duration + 1)
                                    }
                                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-lg font-medium text-slate-700 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-600"
                                >
                                    +
                                </button>

                            </div>

                        </div>

                    </div>

                    <div className="mt-6 flex flex-col gap-3 sm:flex-row">

                        <button
                            onClick={startManualIrrigation}
                            disabled={
                                starting ||
                                !sensorId ||
                                hasActiveCommand
                            }
                            className="flex-1 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {isIrrigating
                                ? "Irrigation in progress..."
                                : hasActiveCommand
                                    ? "Command pending..."
                                    : starting
                                        ? "Starting..."
                                        : "Start irrigation"}
                        </button>

                        <button
                            onClick={cancelCurrentIrrigation}
                            disabled={cancelling || !hasActiveCommand}
                            className="rounded-xl border border-red-200 bg-white px-5 py-3 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
                        >
                            {cancelling ? "Stopping..." : "Stop irrigation"}
                        </button>

                    </div>

                </div>
            )}

            {/* AUTOMATIC */}

            {mode === "automatic" && (
                <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">

                    <h3 className="text-lg font-semibold text-slate-900">
                        Automatic irrigation
                    </h3>

                    <p className="mt-1 text-sm text-slate-500">
                        Choose whether irrigation should be triggered by
                        soil moisture or by a fixed schedule.
                    </p>

                    {/* SUB-MODE SELECTOR */}

                    <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">

                        <button
                            onClick={() =>
                                changeAutomaticStrategy("moisture")
                            }
                            className={`rounded-xl border p-4 text-left transition ${automaticSubMode === "moisture"
                                ? "border-blue-500 bg-blue-50"
                                : "border-slate-200 hover:bg-slate-50"
                                }`}
                        >
                            <p className="font-semibold text-slate-900">
                                By moisture
                            </p>

                            <p className="mt-1 text-sm text-slate-500">
                                Irrigate when moisture drops below a threshold.
                            </p>
                        </button>

                        <button
                            onClick={() =>
                                changeAutomaticStrategy("schedule")
                            }
                            className={`rounded-xl border p-4 text-left transition ${automaticSubMode === "schedule"
                                ? "border-blue-500 bg-blue-50"
                                : "border-slate-200 hover:bg-slate-50"
                                }`}
                        >
                            <p className="font-semibold text-slate-900">
                                By schedule
                            </p>

                            <p className="mt-1 text-sm text-slate-500">
                                Irrigate at fixed times on chosen days.
                            </p>
                        </button>

                    </div>

                    {/* BY MOISTURE */}

                    {automaticSubMode === "moisture" && (
                        <>

                            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">

                                <div className="rounded-xl bg-slate-50 p-4">

                                    <p className="text-sm text-slate-500">
                                        Current moisture
                                    </p>

                                    <p className="mt-2 text-2xl font-bold text-slate-900">
                                        {moisture}%
                                    </p>

                                </div>

                                <div className="rounded-xl bg-slate-50 p-4">

                                    <p className="text-sm text-slate-500">
                                        Moisture threshold
                                    </p>

                                    <div className="mt-2 flex items-center gap-2">

                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={threshold}
                                            onChange={(e) =>
                                                setThreshold(
                                                    Number(e.target.value)
                                                )
                                            }
                                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                                        />

                                        <span className="text-sm text-slate-500">
                                            %
                                        </span>

                                    </div>

                                </div>

                                <div className="rounded-xl bg-slate-50 p-4">

                                    <p className="text-sm text-slate-500">
                                        Irrigation duration
                                    </p>

                                    <div className="mt-2 flex items-center gap-2">

                                        <button
                                            onClick={() =>
                                                setMoistureDuration(
                                                    Math.max(
                                                        1,
                                                        moistureDuration - 1
                                                    )
                                                )
                                            }
                                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-base font-medium text-slate-700 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-600"
                                        >
                                            −
                                        </button>

                                        <div className="flex h-8 flex-1 items-center justify-center rounded-lg border border-slate-200 bg-white px-2">

                                            <span className="text-sm font-semibold text-slate-900">
                                                {moistureDuration}
                                            </span>

                                            <span className="ml-1 text-xs text-slate-500">
                                                min
                                            </span>

                                        </div>

                                        <button
                                            onClick={() =>
                                                setMoistureDuration(
                                                    moistureDuration + 1
                                                )
                                            }
                                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-base font-medium text-slate-700 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-600"
                                        >
                                            +
                                        </button>

                                    </div>

                                </div>

                                <div className="rounded-xl bg-slate-50 p-4">

                                    <p className="text-sm text-slate-500">
                                        Automatic mode
                                    </p>

                                    <div className="mt-2">
                                        <StrategyToggle
                                            active={
                                                activeStrategy ===
                                                "moisture"
                                            }
                                            onClick={() =>
                                                toggleStrategy("moisture")
                                            }
                                        />
                                    </div>

                                </div>

                            </div>

                            <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">

                                <p className="text-sm text-slate-500">
                                    Current decision
                                </p>

                                <p className="mt-1 font-semibold text-slate-900">
                                    {moisture < threshold
                                        ? "Irrigation recommended"
                                        : "No irrigation needed"}
                                </p>

                            </div>

                            <button
                                onClick={saveMoistureSettings}
                                disabled={saving}
                                className="mt-5 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            >
                                {saving ? "Saving..." : "Save settings"}
                            </button>

                        </>
                    )}

                    {/* BY SCHEDULE */}

                    {automaticSubMode === "schedule" && (
                        <>

                            <div className="mt-6 flex items-center justify-between rounded-xl bg-slate-50 p-4">

                                <div>

                                    <p className="text-sm text-slate-500">
                                        Schedule automation
                                    </p>

                                    <p className="mt-1 text-sm text-slate-400">
                                        Irrigation will follow the configured schedules.
                                    </p>

                                </div>

                                <StrategyToggle
                                    active={
                                        activeStrategy === "schedule"
                                    }
                                    onClick={() =>
                                        toggleStrategy("schedule")
                                    }
                                />

                            </div>

                            {/* NEW SCHEDULE */}

                            <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5">

                                <p className="text-sm font-medium text-slate-500">
                                    New schedule
                                </p>

                                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">

                                    <div>

                                        <p className="text-sm text-slate-500">
                                            Start time
                                        </p>

                                        <input
                                            type="time"
                                            value={newTime}
                                            onChange={(e) =>
                                                setNewTime(e.target.value)
                                            }
                                            className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                                        />

                                    </div>

                                    <div>

                                        <p className="text-sm text-slate-500">
                                            Duration
                                        </p>

                                        <div className="mt-2 flex items-center gap-3">

                                            <button
                                                onClick={() =>
                                                    setNewDurationMinutes(
                                                        Math.max(
                                                            1,
                                                            newDurationMinutes - 1
                                                        )
                                                    )
                                                }
                                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-lg font-medium text-slate-700 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-600"
                                            >
                                                −
                                            </button>

                                            <div className="flex h-9 min-w-[80px] items-center justify-center rounded-lg border border-slate-200 bg-white px-3">

                                                <span className="text-sm font-semibold text-slate-900">
                                                    {newDurationMinutes}
                                                </span>

                                                <span className="ml-1 text-sm text-slate-500">
                                                    min
                                                </span>

                                            </div>

                                            <button
                                                onClick={() =>
                                                    setNewDurationMinutes(
                                                        newDurationMinutes + 1
                                                    )
                                                }
                                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-lg font-medium text-slate-700 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-600"
                                            >
                                                +
                                            </button>

                                        </div>

                                    </div>

                                </div>

                                <div className="mt-4">

                                    <p className="text-sm text-slate-500">
                                        Repeat on
                                    </p>

                                    <div className="mt-2 flex flex-wrap gap-2">

                                        {WEEK_DAYS.map((day) => (
                                            <button
                                                key={day}
                                                onClick={() =>
                                                    toggleNewDay(day)
                                                }
                                                className={`h-9 min-w-[44px] rounded-lg border px-3 text-sm font-medium transition ${newDays.includes(day)
                                                    ? "border-blue-500 bg-blue-50 text-blue-600"
                                                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                                    }`}
                                            >
                                                {day}
                                            </button>
                                        ))}

                                    </div>

                                </div>

                                <button
                                    onClick={addSchedule}
                                    disabled={newDays.length === 0}
                                    className="mt-5 w-full rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Add schedule
                                </button>

                            </div>

                            {/* EXISTING SCHEDULES */}

                            <div className="mt-5">

                                <p className="text-sm font-medium text-slate-500">
                                    Active schedules
                                </p>

                                {schedules.length === 0 ? (
                                    <p className="mt-3 text-sm text-slate-400">
                                        No schedules yet. Add one above.
                                    </p>
                                ) : (
                                    <div className="mt-3 flex flex-col gap-3">

                                        {schedules.map((schedule) => (
                                            <div
                                                key={schedule.id}
                                                className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
                                            >

                                                <div>

                                                    <p className="font-semibold text-slate-900">
                                                        {schedule.time} ·{" "}
                                                        {schedule.durationMinutes}{" "}
                                                        min
                                                    </p>

                                                    <p className="mt-1 text-sm text-slate-500">
                                                        {schedule.days.join(", ")}
                                                    </p>

                                                </div>

                                                <div className="flex items-center gap-2">

                                                    <button
                                                        onClick={() =>
                                                            toggleScheduleEnabled(
                                                                schedule.id
                                                            )
                                                        }
                                                        className={`rounded-full px-4 py-2 text-sm font-semibold ${schedule.enabled
                                                            ? "bg-emerald-100 text-emerald-700"
                                                            : "bg-slate-200 text-slate-600"
                                                            }`}
                                                    >
                                                        {schedule.enabled
                                                            ? "Enabled"
                                                            : "Disabled"}
                                                    </button>

                                                    <button
                                                        onClick={() =>
                                                            removeSchedule(
                                                                schedule.id
                                                            )
                                                        }
                                                        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-500 transition hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                                                    >
                                                        Remove
                                                    </button>

                                                </div>

                                            </div>
                                        ))}

                                    </div>
                                )}

                            </div>

                        </>
                    )}

                </div>
            )}

            {/* INTELLIGENT */}

            {mode === "intelligent" && (
                <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">

                    <h3 className="text-lg font-semibold text-slate-900">
                        Intelligent irrigation
                    </h3>

                    <p className="mt-1 text-sm text-slate-500">
                        Use prediction, environmental conditions and
                        historical data.
                    </p>

                    <div className="mt-5 flex items-center justify-between rounded-xl bg-slate-50 p-4">

                        <div>

                            <p className="text-sm text-slate-500">
                                Intelligent automation
                            </p>

                            <p className="mt-1 text-sm text-slate-400">
                                Intelligent automation is currently selected.
                            </p>

                        </div>

                        <StrategyToggle
                            active={activeStrategy === "intelligent"}
                            onClick={() =>
                                toggleStrategy("intelligent")
                            }
                        />

                    </div>

                    <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">

                        <InfoCard
                            title="Soil moisture"
                            value={`${moisture}%`}
                        />

                        <InfoCard
                            title="Temperature"
                            value="24°C"
                        />

                        <InfoCard
                            title="Air humidity"
                            value="61%"
                        />

                        <InfoCard
                            title="Rain probability"
                            value="20%"
                        />

                    </div>

                    <div className="mt-6 rounded-xl border border-slate-200 p-5">

                        <p className="text-sm text-slate-500">
                            Model recommendation
                        </p>

                        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">

                            <div>

                                <p className="font-semibold text-slate-900">
                                    Irrigation recommended
                                </p>

                                <p className="mt-1 text-sm text-slate-500">
                                    Predicted soil moisture is expected
                                    to fall below the optimal range.
                                </p>

                            </div>

                            <span className="rounded-full bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-600">
                                Recommended
                            </span>

                        </div>

                    </div>

                    <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">

                        <InfoCard
                            title="Predicted moisture"
                            value="34%"
                        />

                        <InfoCard
                            title="Recommended duration"
                            value="4 min"
                        />

                    </div>

                    <button
                        className="mt-6 w-full rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700"
                    >
                        Apply recommendation
                    </button>

                </div>
            )}

        </section>
    );
}

/*
 * ---------------------------------------------------------
 * COMMAND STATUS CARD
 *
 *  | last / previous irrigation |  | current / latest |
 *
 * left  = most recent COMPLETED irrigation from
 *         irrigation_history (independent of "current")
 * right = the current command from irrigation_commands
 *
 * Steps: Pending -> Irrigation active -> Completed
 * "Sent" is not shown as its own step; a "sent" command is
 * still shown as "Pending" until it actually starts running.
 * ---------------------------------------------------------
 */

const COMMAND_STEPS = [
    "Pending",
    "Irrigation active",
    "Completed",
];

/*
 * Index of the step the command has reached.
 * Failed / cancelled commands keep the last step
 * they are known to have reached.
 */
function getStepIndex(command: IrrigationCommand): number {
    switch (command.status) {
        case "pending":
        case "sent":
            return 0;
        case "executing":
            return 1;
        case "completed":
            return 2;
        default:
            return command.started_at ? 1 : 0;
    }
}

function getStatusBadge(status: CommandStatus): {
    label: string;
    className: string;
} {
    switch (status) {
        case "pending":
            return {
                label: "Pending",
                className: "bg-amber-100 text-amber-700",
            };
        case "sent":
            return {
                label: "Sent",
                className: "bg-blue-100 text-blue-700",
            };
        case "executing":
            return {
                label: "Irrigation active",
                className: "bg-emerald-100 text-emerald-700",
            };
        case "completed":
            return {
                label: "Completed",
                className: "bg-emerald-100 text-emerald-700",
            };
        case "failed":
            return {
                label: "Failed",
                className: "bg-red-100 text-red-700",
            };
        default:
            return {
                label: "Cancelled",
                className: "bg-slate-200 text-slate-600",
            };
    }
}

function getSourceLabel(source: string): string {
    switch (source) {
        case "manual":
            return "Manual";
        case "automatic_moisture":
            return "Automatic (moisture)";
        case "automatic_schedule":
            return "Automatic (schedule)";
        case "intelligent":
            return "Intelligent";
        case "system":
            return "System";
        default:
            return source;
    }
}

function getModeLabel(mode: string): string {
    switch (mode) {
        case "manual":
            return "Manual";
        case "automatic":
            return "Automatic";
        case "intelligent":
            return "Intelligent";
        default:
            return mode;
    }
}

function formatDateTime(value: string | null): string {
    if (!value) return "—";

    return new Date(value).toLocaleString([], {
        dateStyle: "short",
        timeStyle: "short",
    });
}

function formatDuration(minutes: number | null): string {
    return minutes ? `${minutes} min` : "—";
}

function CommandStatusCard({
    current,
    previous,
}: {
    current: IrrigationCommand | null;
    previous: HistoryRecord | null;
}) {
    /*
     * Nothing to show at all: no command has ever been sent,
     * and no irrigation has ever completed.
     */
    if (!current && !previous) {
        return (
            <div className="mb-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm">
                <p className="text-sm text-slate-400">
                    <span className="font-medium text-slate-500">
                        Irrigation status:
                    </span>{" "}
                    no irrigations yet
                </p>
            </div>
        );
    }

    const badge = current ? getStatusBadge(current.status) : null;
    const stepIndex = current ? getStepIndex(current) : 0;

    const isCompleted = current?.status === "completed";
    const isStopped =
        current?.status === "failed" ||
        current?.status === "cancelled";
    const isFinished = isCompleted || isStopped;

    const isDone = (index: number) =>
        isFinished ? index <= stepIndex : index < stepIndex;

    const isCurrent = (index: number) =>
        !isFinished && index === stepIndex;

    const isStoppedAt = (index: number) =>
        isStopped && index === stepIndex + 1;

    /*
     * Left panel label depends on whether there is a command
     * at all, and if so, whether it is still in progress.
     */
    const previousLabel = !current
        ? "Most recent irrigation"
        : isFinished
            ? "Previous irrigation"
            : "Last irrigation";

    const currentLabel = isFinished
        ? "Latest irrigation"
        : "Current";

    const currentMeta = current
        ? [
            getSourceLabel(current.source),
            formatDateTime(current.created_at),
        ].join(" · ")
        : "";

    return (
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">

            {/* PREVIOUS / LAST COMPLETED (from irrigation_history) */}

            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">

                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    {previousLabel}
                </p>

                {previous ? (
                    <div className="mt-1.5">

                        <p className="text-sm font-semibold text-slate-900">
                            <span className="mr-1 text-emerald-600">
                                ✓
                            </span>
                            {formatDuration(previous.duration)}
                            <span className="ml-2 text-xs font-normal text-slate-500">
                                {getModeLabel(previous.mode)}
                            </span>
                        </p>

                        <p className="mt-0.5 text-xs text-slate-500">
                            {formatDateTime(
                                previous.ended_at ??
                                previous.started_at
                            )}
                        </p>

                    </div>
                ) : (
                    <p className="mt-1.5 text-sm text-slate-400">
                        No previous irrigation
                    </p>
                )}

            </div>

            {/* CURRENT / LATEST (from irrigation_commands) */}

            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm sm:col-span-2">

                {current ? (
                    <>

                        <div className="flex items-start justify-between gap-3">

                            <div className="min-w-0">

                                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                                    {currentLabel}
                                </p>

                                <p className="mt-1.5 truncate text-sm font-semibold text-slate-900">
                                    {formatDuration(
                                        current.duration_minutes
                                    )}
                                    <span className="ml-2 text-xs font-normal text-slate-500">
                                        {currentMeta}
                                    </span>
                                </p>

                            </div>

                            {badge && (
                                <span
                                    title="Refreshes every 5 seconds"
                                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${badge.className}`}
                                >
                                    {badge.label}
                                </span>
                            )}

                        </div>

                        <ol className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">

                            {COMMAND_STEPS.map((label, index) => {
                                const isLast =
                                    index === COMMAND_STEPS.length - 1;

                                let dotClass = "bg-slate-300";

                                if (isDone(index)) {
                                    dotClass = "bg-emerald-500";
                                } else if (isCurrent(index)) {
                                    dotClass = "animate-pulse bg-blue-600";
                                } else if (isStoppedAt(index)) {
                                    dotClass = "bg-red-500";
                                }

                                const highlighted =
                                    isDone(index) ||
                                    isCurrent(index) ||
                                    isStoppedAt(index);

                                return (
                                    <li
                                        key={label}
                                        className="flex items-center gap-1"
                                    >

                                        <span
                                            className={`h-2.5 w-2.5 rounded-full ${dotClass}`}
                                        />

                                        <span
                                            className={`text-xs ${highlighted
                                                ? "font-medium text-slate-800"
                                                : "text-slate-400"
                                                }`}
                                        >
                                            {label}
                                        </span>

                                        {!isLast && (
                                            <span
                                                className={`mx-1 h-px w-3 sm:w-5 ${isDone(index + 1)
                                                    ? "bg-emerald-500"
                                                    : "bg-slate-200"
                                                    }`}
                                            />
                                        )}

                                    </li>
                                );
                            })}

                        </ol>

                    </>
                ) : (
                    <p className="text-sm text-slate-400">
                        No commands sent yet
                    </p>
                )}

            </div>

        </div>
    );
}

function StrategyToggle({
    active,
    onClick,
}: {
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className={`rounded-full px-4 py-2 text-sm font-semibold ${active
                ? "bg-emerald-100 text-emerald-700"
                : "bg-slate-200 text-slate-600"
                }`}
        >
            {active ? "Enabled" : "Disabled"}
        </button>
    );
}

function InfoCard({
    title,
    value,
}: {
    title: string;
    value: string;
}) {
    return (
        <div className="rounded-xl bg-slate-50 p-4">

            <p className="text-sm text-slate-500">
                {title}
            </p>

            <p className="mt-2 text-xl font-bold text-slate-900">
                {value}
            </p>

        </div>
    );
}