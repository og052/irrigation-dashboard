"use client";

import {
    ScatterChart,
    Scatter,
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

/*
 * Color of the irrigation lines and the translucent area.
 * Change it here if you want a different color.
 */
const IRRIGATION_COLOR = "#10b981";

export default function MoistureChart({
    data,
    irrigations = [],
}: {
    data: Reading[];
    irrigations?: Irrigation[];
}) {
    const today = new Date();

    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(today);
    endOfDay.setHours(24, 0, 0, 0);

    const chartData = data
        .filter((reading) => {
            const time = new Date(reading.created_at);

            return time >= startOfDay && time <= endOfDay;
        })
        .map((reading) => {
            const date = new Date(reading.created_at);

            const hours =
                date.getHours() +
                date.getMinutes() / 60 +
                date.getSeconds() / 3600;

            return {
                time: hours,
                moisture: Number(reading.moisture),
                displayTime: date.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
            };
        });

    /*
     * Converts a date to "hour of the day" (0 - 24), the same way
     * the readings are converted. Dates outside of today are
     * clamped to the edges of the chart.
     */
    function toHour(date: Date) {
        if (date < startOfDay) return 0;
        if (date >= endOfDay) return 24;

        return (
            date.getHours() +
            date.getMinutes() / 60 +
            date.getSeconds() / 3600
        );
    }

    const now = new Date();

    const periods = irrigations
        .map((irrigation) => {
            const start = new Date(irrigation.started_at);

            const end = irrigation.ended_at
                ? new Date(irrigation.ended_at)
                : now;

            return {
                id: irrigation.id,
                x1: toHour(start),
                x2: toHour(end),

                /*
                 * Only draw a vertical line if that moment is
                 * really inside of today (not clamped).
                 */
                showStartLine:
                    start >= startOfDay && start < endOfDay,

                showEndLine:
                    irrigation.ended_at !== null &&
                    end >= startOfDay &&
                    end < endOfDay,
            };
        })
        .filter((period) => period.x1 < period.x2);

    return (
        <div>

            <div style={{ width: "100%", height: "320px" }}>
                <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart>
                        <CartesianGrid
                            stroke="#e5e7eb"
                            strokeDasharray="3 3"
                        />

                        <XAxis
                            type="number"
                            dataKey="time"
                            domain={[0, 24]}
                            ticks={[2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]}
                            tickFormatter={(value) =>
                                `${String(value).padStart(2, "0")}:00`
                            }
                            tick={{ fill: "#374151" }}
                        />

                        <YAxis
                            type="number"
                            dataKey="moisture"
                            domain={[0, 100]}
                            tick={{ fill: "#374151" }}
                            label={{
                                value: "Moisture (%)",
                                angle: -90,
                                position: "insideLeft",
                                fill: "#374151",
                            }}
                        />

                        <Tooltip
                            cursor={{ strokeDasharray: "3 3" }}
                            formatter={(value) => [
                                `${value}%`,
                                "Moisture",
                            ]}
                            labelFormatter={(_, payload) => {
                                if (payload && payload.length > 0) {
                                    return payload[0].payload.displayTime;
                                }

                                return "";
                            }}
                        />

                        {/* IRRIGATION AREAS (drawn first, behind the points) */}

                        {periods.map((period) => (
                            <ReferenceArea
                                key={`${period.id}-area`}
                                x1={period.x1}
                                x2={period.x2}
                                fill={IRRIGATION_COLOR}
                                fillOpacity={0.12}
                                stroke="none"
                            />
                        ))}

                        {/* START LINES */}

                        {periods
                            .filter((period) => period.showStartLine)
                            .map((period) => (
                                <ReferenceLine
                                    key={`${period.id}-start`}
                                    x={period.x1}
                                    stroke={IRRIGATION_COLOR}
                                    strokeOpacity={0.7}
                                    strokeWidth={1.5}
                                />
                            ))}

                        {/* END LINES */}

                        {periods
                            .filter((period) => period.showEndLine)
                            .map((period) => (
                                <ReferenceLine
                                    key={`${period.id}-end`}
                                    x={period.x2}
                                    stroke={IRRIGATION_COLOR}
                                    strokeOpacity={0.7}
                                    strokeWidth={1.5}
                                />
                            ))}

                        <Scatter
                            name="Moisture"
                            data={chartData}
                            fill="#2563eb"
                            line={{ type: "monotone" }}
                        />
                    </ScatterChart>
                </ResponsiveContainer>
            </div>

            {periods.length > 0 && (
                <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">

                    <span
                        className="h-3 w-4 rounded-sm border-x"
                        style={{
                            backgroundColor: `${IRRIGATION_COLOR}1f`,
                            borderColor: IRRIGATION_COLOR,
                        }}
                    />

                    Irrigation ({periods.length})

                </div>
            )}

        </div>
    );
}