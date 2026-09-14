"use client";

import {
    ScatterChart,
    Scatter,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from "recharts";

type Reading = {
    created_at: string;
    moisture: number;
};

export default function MoistureChart({
    data,
}: {
    data: Reading[];
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

    return (
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
                            `${ String(value).padStart(2, "0") }:00`
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
                        formatter={(value, name) => [
                            `${ value }% `,
                            "Moisture",
                        ]}
                        labelFormatter={(_, payload) => {
                            if (payload && payload.length > 0) {
                                return payload[0].payload.displayTime;
                            }

                            return "";
                        }}
                    />

                    <Scatter
                        name="Moisture"
                        data={chartData}
                        fill="#2563eb"
                        line={{ type: "monotone" }}
                    />
                </ScatterChart>
            </ResponsiveContainer>
        </div>
    );
}