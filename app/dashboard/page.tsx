"use client";

import { useEffect, useState } from "react";
import MoistureChart from "../MoistureChart";
import IrrigationControl from "../components/IrrigationControl";


type Device = {
    id: string;
    name: string;
    device_code: string;
    last_seen: string | null;
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

        return difference < 180;
    }

    function handleSensorClick(sensor: Sensor) {
        setSelectedSensor(sensor);
        loadReadings(sensor.id);
    }

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
                        <div className="flex items-center gap-2 rounded-full bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700">
                            <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
                            System online
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

                            <div className="rounded-xl bg-emerald-50 px-3 py-2 text-emerald-600">
                                ✓
                            </div>
                        </div>

                        <p className="mt-4 text-3xl font-bold text-emerald-600">
                            Online
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                            All systems operational
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


                                            {isDeviceOnline(device.last_seen) ? (
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


                                    {/* SENSORS */}
                                    <div className="space-y-3 p-5">

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


                        {/* CHART */}
                        <div className="p-6">

                            {readings.length > 0 ? (
                                <MoistureChart data={readings} />
                            ) : (
                                <div className="flex h-80 items-center justify-center text-sm text-slate-400">
                                    No measurements available for this sensor.
                                </div>
                            )}

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