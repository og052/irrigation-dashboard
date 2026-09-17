"use client";

import { useState } from "react";

type IrrigationMode = "manual" | "automatic" | "intelligent";
type AutomaticSubMode = "moisture" | "schedule";
type WeekDay = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
type ActiveStrategy = "none" | "moisture" | "schedule" | "intelligent";

type Schedule = {
    id: string;
    time: string;
    durationMinutes: number;
    days: WeekDay[];
    enabled: boolean;
};

const WEEK_DAYS: WeekDay[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type Props = {
    sensorCode: string;
    moisture: number;
};

export default function IrrigationControl({
    sensorCode,
    moisture,
}: Props) {
    const [mode, setMode] = useState<IrrigationMode>("manual");
    const [duration, setDuration] = useState(5);
    const [threshold, setThreshold] = useState(40);

    // Only one automatic strategy can be active at a time.
    // Manual is independent and always available.
    const [activeStrategy, setActiveStrategy] =
        useState<ActiveStrategy>("none");

    function activateStrategy(strategy: Exclude<ActiveStrategy, "none">) {
        setActiveStrategy((prev) => (prev === strategy ? "none" : strategy));
    }

    const [automaticSubMode, setAutomaticSubMode] =
        useState<AutomaticSubMode>("moisture");

    const [schedules, setSchedules] = useState<Schedule[]>([]);
    const [newTime, setNewTime] = useState("08:00");
    const [newDurationMinutes, setNewDurationMinutes] = useState(15);
    const [newDays, setNewDays] = useState<WeekDay[]>([]);

    function toggleNewDay(day: WeekDay) {
        setNewDays((prev) =>
            prev.includes(day)
                ? prev.filter((d) => d !== day)
                : [...prev, day]
        );
    }

    function addSchedule() {
        if (newDays.length === 0) return;

        const schedule: Schedule = {
            id: crypto.randomUUID(),
            time: newTime,
            durationMinutes: newDurationMinutes,
            days: newDays,
            enabled: true,
        };

        setSchedules((prev) => [...prev, schedule]);
        setNewDays([]);
        setNewDurationMinutes(15);
        setNewTime("08:00");
    }

    function removeSchedule(id: string) {
        setSchedules((prev) => prev.filter((s) => s.id !== id));
    }

    function toggleScheduleEnabled(id: string) {
        setSchedules((prev) =>
            prev.map((s) =>
                s.id === id ? { ...s, enabled: !s.enabled } : s
            )
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
                        onClick={() => setMode("manual")}
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
                        onClick={() => setMode("automatic")}
                        className={`rounded-xl border p-4 text-left transition ${mode === "automatic"
                            ? "border-blue-500 bg-blue-50"
                            : "border-slate-200 hover:bg-slate-50"
                            }`}
                    >
                        <p className="font-semibold text-slate-900">
                            Automatic
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                            Irrigate according to moisture.
                        </p>
                    </button>

                    <button
                        onClick={() => setMode("intelligent")}
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

            {/* MANUAL */}
            {mode === "manual" && (
                <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">

                    <h3 className="text-lg font-semibold text-slate-900">
                        Manual irrigation
                    </h3>

                    <p className="mt-1 text-sm text-slate-500">
                        Start irrigation manually for the selected sensor.
                    </p>

                    <div className="mt-5 grid w-full grid-cols-2 gap-5">

                        {/* VALVE STATUS */}
                        <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-5">

                            <p className="text-sm font-medium text-slate-500">
                                Valve status
                            </p>

                            <div className="mt-4 flex items-center gap-3">
                                <span className="h-3 w-3 rounded-full bg-slate-400" />

                                <span className="text-base font-semibold text-slate-900">
                                    Closed
                                </span>
                            </div>

                        </div>

                        {/* IRRIGATION DURATION */}
                        <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-5">

                            <p className="text-sm font-medium text-slate-500">
                                Irrigation duration
                            </p>

                            <div className="mt-4 flex items-center gap-4">

                                <button
                                    onClick={() =>
                                        setDuration(Math.max(1, duration - 1))
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
                    <button
                        className="mt-6 w-full rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700"
                    >
                        Start irrigation
                    </button>

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
                            onClick={() => setAutomaticSubMode("moisture")}
                            className={`rounded-xl border p-4 text-left transition ${automaticSubMode === "moisture"
                                ? "border-blue-500 bg-blue-50"
                                : "border-slate-200 hover:bg-slate-50"
                                }`}
                        >
                            <p className="font-semibold text-slate-900">
                                By moisture
                            </p>

                            <p className="mt-1 text-sm text-slate-500">
                                Irrigate when moisture drops below a
                                threshold.
                            </p>
                        </button>

                        <button
                            onClick={() => setAutomaticSubMode("schedule")}
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
                            <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">

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
                                        Automatic mode
                                    </p>

                                    <button
                                        onClick={() =>
                                            activateStrategy("moisture")
                                        }
                                        className={`mt-2 rounded-full px-4 py-2 text-sm font-semibold ${activeStrategy === "moisture"
                                            ? "bg-emerald-100 text-emerald-700"
                                            : "bg-slate-200 text-slate-600"
                                            }`}
                                    >
                                        {activeStrategy === "moisture"
                                            ? "Enabled"
                                            : "Disabled"}
                                    </button>

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
                                className="mt-5 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                            >
                                Save settings
                            </button>
                        </>
                    )}

                    {/* BY SCHEDULE */}
                    {automaticSubMode === "schedule" && (
                        <>
                            {/* STRATEGY TOGGLE */}
                            <div className="mt-6 flex items-center justify-between rounded-xl bg-slate-50 p-4">

                                <div>
                                    <p className="text-sm text-slate-500">
                                        Schedule automation
                                    </p>

                                    <p className="mt-1 text-sm text-slate-400">
                                        Enabling this turns off moisture
                                        and intelligent automation.
                                    </p>
                                </div>

                                <button
                                    onClick={() => activateStrategy("schedule")}
                                    className={`rounded-full px-4 py-2 text-sm font-semibold ${activeStrategy === "schedule"
                                        ? "bg-emerald-100 text-emerald-700"
                                        : "bg-slate-200 text-slate-600"
                                        }`}
                                >
                                    {activeStrategy === "schedule"
                                        ? "Enabled"
                                        : "Disabled"}
                                </button>

                            </div>

                            {/* NEW SCHEDULE FORM */}
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
                                                onClick={() => toggleNewDay(day)}
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
                                                        {schedule.durationMinutes} min
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

                    {/* STRATEGY TOGGLE */}
                    <div className="mt-5 flex items-center justify-between rounded-xl bg-slate-50 p-4">

                        <div>
                            <p className="text-sm text-slate-500">
                                Intelligent automation
                            </p>

                            <p className="mt-1 text-sm text-slate-400">
                                Enabling this turns off moisture and
                                schedule automation.
                            </p>
                        </div>

                        <button
                            onClick={() => activateStrategy("intelligent")}
                            className={`rounded-full px-4 py-2 text-sm font-semibold ${activeStrategy === "intelligent"
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-slate-200 text-slate-600"
                                }`}
                        >
                            {activeStrategy === "intelligent"
                                ? "Enabled"
                                : "Disabled"}
                        </button>

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