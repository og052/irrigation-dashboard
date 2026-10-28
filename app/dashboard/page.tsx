"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import MoistureChart from "../MoistureChart";
import IrrigationControl from "../components/IrrigationControl";
import { useTodayIrrigations } from "../useTodayIrrigations";
import WeatherPanel from "../WeatherPanel";

const DeviceLocationPicker = dynamic(
    () => import("../DeviceLocationPicker"),
    { ssr: false }
);
// Leaflet koristi window, pa mora biti ssr:false


type Device = {
    id: string;
    name: string;
    device_code: string;
    last_seen: string | null;
    latitude: number | null;
    longitude: number | null;
};

type Sensor = {
    id: string;
    name: string;
    sensor_code: string;
    type: string;
    device_id: string;
};

type Reading = {
    created_at: string;
    moisture: number;
};

export default function Home() {
    const [devices, setDevices] = useState<Device[]>([]);
    const [sensors, setSensors] = useState<Sensor[]>([]);
    const [selectedSensor, setSelectedSensor] = useState<Sensor | null>(null);
    const [readings, setReadings] = useState<Reading[]>([]);

    const [editingLocationFor, setEditingLocationFor] =
        useState<string | null>(null);

    const irrigations = useTodayIrrigations({
        sensorId: selectedSensor?.id ?? null,
    });


    useEffect(() => {
        async function loadSensors() {
            const storedUser = localStorage.getItem("user");

            if (!storedUser) {
                window.location.href = "/";
                return;
            }

            const user = JSON.parse(storedUser);

            const response = await fetch(
                `/api/sensors?user_id=${user.id}`
            );

            const result = await response.json();

            if (response.ok) {
                setDevices(result.devices || []);
                setSensors(result.sensors || []);
            }
        }

        loadSensors();

        const interval = setInterval(() => {
            loadSensors();
        }, 30000);

        return () => {
            clearInterval(interval);
        };
    }, []);

    async function loadReadings(sensorId: string) {
        const response = await fetch(
            `/api/readings?sensor_id=${sensorId}`
        );

        const result = await response.json();

        if (response.ok) {
            setReadings(result.readings || []);
        }
    }

    function isDeviceOnline(lastSeen: string | null) {
        if (!lastSeen) return false;

        const difference =
            (Date.now() - new Date(lastSeen).getTime()) / 1000;

        return difference < 720;
    }

    function handleSensorClick(sensor: Sensor) {
        setSelectedSensor(sensor);
        loadReadings(sensor.id);
    }

    /*
     * The device that owns the currently selected sensor - its
     * location is what the weather panel below the chart uses.
     */
    /*
     * Status sistema izveden iz last_seen svih uređaja.
     */
    const onlineCount = devices.filter((d) =>
        isDeviceOnline(d.last_seen)
    ).length;

    const systemStatus =
        devices.length === 0
            ? {
                label: "No devices",
                description: "No devices connected yet",
                badge: "System offline",
                text: "text-slate-500",
                bg: "bg-slate-100",
                dot: "bg-slate-400",
                icon: "–",
            }
            : onlineCount === devices.length
                ? {
                    label: "Online",
                    description: `All ${devices.length} devices online`,
                    badge: "System online",
                    text: "text-emerald-600",
                    bg: "bg-emerald-50",
                    dot: "bg-emerald-500",
                    icon: "✓",
                }
                : onlineCount > 0
                    ? {
                        label: "Partially online",
                        description: `${onlineCount} of ${devices.length} devices online`,
                        badge: "Partially online",
                        text: "text-amber-600",
                        bg: "bg-amber-50",
                        dot: "bg-amber-500",
                        icon: "!",
                    }
                    : {
                        label: "Offline",
                        description: devices.length === 1
                            ? "Device is offline"
                            : `All ${devices.length} devices offline`,
                        badge: "System offline",
                        text: "text-red-600",
                        bg: "bg-red-50",
                        dot: "bg-red-500",
                        icon: "✕",
                    };

    const selectedDevice =
        devices.find((d) => d.id === selectedSensor?.device_id) ?? null;

    return (
        <main className="min-h-screen bg-slate-50 text-slate-900">

            {/* HEADER */}
            <header className="border-b border-slate-200 bg-white">
                <div className="mx-auto flex max-w-7xl items-center justify-between px-8 py-5">

                    <div>
                        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                            Smart Irrigation
                        </h1>

                        <p className="mt-1 text-sm text-slate-500">
                            Intelligent irrigation monitoring system
                        </p>
                    </div>

                    <div className="flex items-center gap-3">
                        <div className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ${systemStatus.bg} ${systemStatus.text}`}>
                            <span className={`h-2 w-2 rounded-full ${systemStatus.dot}`}></span>
                            {systemStatus.badge}
                        </div>
                    </div>

                </div>
            </header>


            {/* CONTENT */}
            <div className="mx-auto max-w-7xl px-8 py-8">

                {/* PAGE TITLE */}
                <div className="mb-8">
                    <h2 className="text-3xl font-bold tracking-tight text-slate-900">
                        Dashboard
                    </h2>

                    <p className="mt-2 text-slate-500">
                        Monitor your irrigation devices and soil conditions.
                    </p>
                </div>


                {/* STATISTICS */}
                <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-3">

                    {/* DEVICES */}
                    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">

                        <div className="flex items-center justify-between">
                            <p className="text-sm font-medium text-slate-500">
                                Devices
                            </p>

                            <div className="rounded-xl bg-blue-50 px-3 py-2 text-blue-600">
                                ⚙
                            </div>
                        </div>

                        <p className="mt-4 text-3xl font-bold text-slate-900">
                            {devices.length}
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                            Connected irrigation units
                        </p>

                    </div>


                    {/* SENSORS */}
                    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">

                        <div className="flex items-center justify-between">
                            <p className="text-sm font-medium text-slate-500">
                                Sensors
                            </p>

                            <div className="rounded-xl bg-violet-50 px-3 py-2 text-violet-600">
                                ◉
                            </div>
                        </div>

                        <p className="mt-4 text-3xl font-bold text-slate-900">
                            {sensors.length}
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                            Soil moisture sensors
                        </p>

                    </div>


                    {/* STATUS */}
                    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">

                        <div className="flex items-center justify-between">
                            <p className="text-sm font-medium text-slate-500">
                                System status
                            </p>

                            <div className={`rounded-xl px-3 py-2 ${systemStatus.bg} ${systemStatus.text}`}>
                                {systemStatus.icon}
                            </div>
                        </div>

                        <p className={`mt-4 text-3xl font-bold ${systemStatus.text}`}>
                            {systemStatus.label}
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                            {systemStatus.description}
                        </p>

                    </div>

                </div>


                {/* DEVICES */}
                <div className="mb-8">

                    <div className="mb-5 flex items-center justify-between">
                        <div>
                            <h2 className="text-xl font-bold text-slate-900">
                                Your devices
                            </h2>

                            <p className="mt-1 text-sm text-slate-500">
                                Select a sensor to view detailed measurements.
                            </p>
                        </div>
                    </div>


                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

                        {devices.map((device) => {

                            const deviceSensors = sensors.filter(
                                (sensor) => sensor.device_id === device.id
                            );

                            return (
                                <div
                                    key={device.id}
                                    className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md"
                                >

                                    {/* DEVICE HEADER */}
                                    <div className="border-b border-slate-100 bg-slate-50 px-6 py-5">

                                        <div className="flex items-center justify-between">

                                            <div className="flex items-center gap-4">

                                                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-100 text-xl">
                                                    ⚙
                                                </div>

                                                <div>
                                                    <h3 className="font-bold text-slate-900">
                                                        {device.name}
                                                    </h3>

                                                    <p className="mt-1 font-mono text-xs text-slate-500">
                                                        {device.device_code}
                                                    </p>
                                                </div>

                                            </div>


                                            <div className="flex items-center gap-2">

                                                <button
                                                    onClick={() =>
                                                        setEditingLocationFor(
                                                            (current) =>
                                                                current ===
                                                                    device.id
                                                                    ? null
                                                                    : device.id
                                                        )
                                                    }
                                                    className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                                                >
                                                    📍{" "}
                                                    {device.latitude
                                                        ? "Edit location"
                                                        : "Set location"}
                                                </button>

                                                {isDeviceOnline(
                                                    device.last_seen
                                                ) ? (
                                                    <div className="flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">
                                                        <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
                                                        Online
                                                    </div>
                                                ) : (
                                                    <div className="flex items-center gap-2 rounded-full bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700">
                                                        <span className="h-2 w-2 rounded-full bg-red-500"></span>
                                                        Offline
                                                    </div>
                                                )}

                                            </div>

                                        </div>

                                    </div>


                                    {/* LOCATION PICKER */}

                                    {editingLocationFor === device.id && (
                                        <div className="border-b border-slate-100 p-5">
                                            <DeviceLocationPicker
                                                deviceId={device.id}
                                                initialLatitude={
                                                    device.latitude
                                                }
                                                initialLongitude={
                                                    device.longitude
                                                }
                                                onSaved={(lat, lng) => {
                                                    setDevices((prev) =>
                                                        prev.map((d) =>
                                                            d.id === device.id
                                                                ? {
                                                                    ...d,
                                                                    latitude:
                                                                        lat,
                                                                    longitude:
                                                                        lng,
                                                                }
                                                                : d
                                                        )
                                                    );
                                                    setEditingLocationFor(
                                                        null
                                                    );
                                                }}
                                                onClose={() =>
                                                    setEditingLocationFor(
                                                        null
                                                    )
                                                }
                                            />
                                        </div>
                                    )}


                                    {/* WEATHER */}

                                    {device.latitude !== null &&
                                        device.longitude !== null && (
                                            <div className="border-b border-slate-100 p-5">
                                                <WeatherPanel
                                                    latitude={
                                                        device.latitude
                                                    }
                                                    longitude={
                                                        device.longitude
                                                    }
                                                />
                                            </div>
                                        )}


                                    {/* SENSORS */}
                                    <div className="space-y-3 p-5">

                                        {deviceSensors.length === 0 && (
                                            <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">
                                                No sensors on this device yet.
                                            </p>
                                        )}

                                        {deviceSensors.map((sensor) => {

                                            const isSelected =
                                                selectedSensor?.id === sensor.id;

                                            return (
                                                <button
                                                    key={sensor.id}
                                                    onClick={() =>
                                                        handleSensorClick(sensor)
                                                    }
                                                    className={`w-full rounded-xl border p-4 text-left transition ${isSelected
                                                        ? "border-blue-500 bg-blue-50 shadow-sm"
                                                        : "border-slate-200 bg-white hover:border-blue-300 hover:bg-slate-50"
                                                        }`}
                                                >

                                                    <div className="flex items-center justify-between">

                                                        <div className="flex items-center gap-3">

                                                            <div
                                                                className={`flex h-10 w-10 items-center justify-center rounded-lg ${isSelected
                                                                    ? "bg-blue-600 text-white"
                                                                    : "bg-slate-100 text-slate-500"
                                                                    }`}
                                                            >
                                                                💧
                                                            </div>

                                                            <div>

                                                                <p className="font-semibold text-slate-900">
                                                                    {sensor.name}
                                                                </p>

                                                                <p className="mt-1 font-mono text-xs text-slate-500">
                                                                    {sensor.sensor_code}
                                                                </p>

                                                            </div>

                                                        </div>


                                                        <div className="text-right">

                                                            <p className="text-xs text-slate-400">
                                                                Type
                                                            </p>

                                                            <p className="mt-1 text-xs font-medium text-slate-600">
                                                                {sensor.type}
                                                            </p>

                                                        </div>

                                                    </div>

                                                </button>
                                            );

                                        })}

                                    </div>

                                </div>
                            );
                        })}

                    </div>

                </div>


                {/* EMPTY STATE */}
                {devices.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">

                        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-2xl">
                            ⚙
                        </div>

                        <h3 className="mt-4 font-semibold text-slate-900">
                            No devices found
                        </h3>

                        <p className="mt-1 text-sm text-slate-500">
                            Connect an irrigation device to start monitoring.
                        </p>

                    </div>
                )}


                {/* SENSOR DETAILS */}
                {selectedSensor && (
                    <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">

                        {/* CHART HEADER */}
                        <div className="border-b border-slate-100 px-6 py-5">

                            <div className="flex items-center justify-between">

                                <div>

                                    <div className="flex items-center gap-3">

                                        <h2 className="text-xl font-bold text-slate-900">
                                            {selectedSensor.name}
                                        </h2>

                                        <span className="rounded-full bg-blue-50 px-3 py-1 font-mono text-xs font-medium text-blue-600">
                                            {selectedSensor.sensor_code}
                                        </span>

                                    </div>

                                    <p className="mt-1 text-sm text-slate-500">
                                        Soil moisture measurements · Today
                                    </p>

                                </div>


                                <div className="hidden text-right sm:block">

                                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                                        Measurements
                                    </p>

                                    <p className="mt-1 text-lg font-bold text-slate-900">
                                        {readings.length}
                                    </p>

                                </div>

                            </div>

                        </div>


                        {/* CHART - moisture, irrigation, temperature and
                            rain probability all overlaid, with filter
                            chips to toggle each series. */}
                        <div className="p-6">

                            {/* Graf se prikazuje i bez mjerenja (prazne
                                ose + vrijeme/navodnjavanje ako postoje). */}
                            <MoistureChart
                                data={readings}
                                irrigations={irrigations}
                                latitude={selectedDevice?.latitude}
                                longitude={selectedDevice?.longitude}
                            />

                        </div>

                    </div>
                )}

                {/* IRRIGATION CONTROL */}
                {selectedSensor && (
                    <IrrigationControl
                        sensorCode={selectedSensor.sensor_code}
                        moisture={
                            readings.length > 0
                                ? readings[readings.length - 1].moisture
                                : 0
                        }
                    />
                )}

            </div>

        </main>
    );
}