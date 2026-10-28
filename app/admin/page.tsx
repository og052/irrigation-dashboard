"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type User = {
    id: string;
    name: string;
    email: string;
};

type Device = {
    id: string;
    name: string;
    device_code: string;
    last_seen: string | null;
    user_id: string;
};

type Sensor = {
    id: string;
    name: string;
    sensor_code: string;
    type: string;
    device_id: string;
};

type UserStatus = "online" | "partial" | "offline" | "no-devices";

const DEFAULT_SENSOR_TYPE = "moisture";

// Isti prag kao na dashboardu.
function isDeviceOnline(lastSeen: string | null) {
    if (!lastSeen) return false;

    return (Date.now() - new Date(lastSeen).getTime()) / 1000 < 180;
}

function formatLastSeen(lastSeen: string | null) {
    if (!lastSeen) return "Never";

    return new Date(lastSeen).toLocaleString();
}

function getUserStatus(userDevices: Device[]): UserStatus {
    if (userDevices.length === 0) return "no-devices";

    const online = userDevices.filter((d) =>
        isDeviceOnline(d.last_seen)
    ).length;

    if (online === userDevices.length) return "online";
    if (online > 0) return "partial";

    return "offline";
}

const STATUS_STYLES: Record<
    UserStatus,
    { label: string; badge: string; dot: string }
> = {
    online: {
        label: "Online",
        badge: "bg-emerald-50 text-emerald-700",
        dot: "bg-emerald-500",
    },
    partial: {
        label: "Partially online",
        badge: "bg-amber-50 text-amber-700",
        dot: "bg-amber-500",
    },
    offline: {
        label: "Offline",
        badge: "bg-red-50 text-red-700",
        dot: "bg-red-500",
    },
    "no-devices": {
        label: "No devices",
        badge: "bg-slate-100 text-slate-600",
        dot: "bg-slate-400",
    },
};

function StatusBadge({ status }: { status: UserStatus }) {
    const style = STATUS_STYLES[status];

    return (
        <span
            className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${style.badge}`}
        >
            <span className={`h-2 w-2 rounded-full ${style.dot}`}></span>
            {style.label}
        </span>
    );
}

// Pop-up prozor za greške (npr. zauzeto ime ili kod).
function AlertModal({
    message,
    onClose,
}: {
    message: string;
    onClose: () => void;
}) {
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === "Escape") onClose();
        }

        window.addEventListener("keydown", onKeyDown);

        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    return (
        <div
            onClick={onClose}
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
        >
            <div
                role="alertdialog"
                aria-modal="true"
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
            >
                <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-lg text-red-600">
                        !
                    </div>
                    <div>
                        <h3 className="font-bold text-slate-900">
                            Could not save
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">
                            {message}
                        </p>
                    </div>
                </div>

                <button
                    type="button"
                    onClick={onClose}
                    autoFocus
                    className="mt-6 w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
                >
                    OK
                </button>
            </div>
        </div>
    );
}

function firmwareUrl(type: "controller" | "sensor", id: string) {
    return `/api/admin/firmware?type=${type}&id=${encodeURIComponent(id)}`;
}

const downloadLinkClass =
    "inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50";

// Pop-up nakon dodavanja uređaja/senzora sa preuzimanjem Arduino koda.
function CreatedModal({
    title,
    downloadUrl,
    onClose,
}: {
    title: string;
    downloadUrl: string;
    onClose: () => void;
}) {
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === "Escape") onClose();
        }

        window.addEventListener("keydown", onKeyDown);

        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    return (
        <div
            onClick={onClose}
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
        >
            <div
                role="dialog"
                aria-modal="true"
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
            >
                <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-lg text-emerald-600">
                        ✓
                    </div>
                    <div>
                        <h3 className="font-bold text-slate-900">{title}</h3>
                        <p className="mt-1 text-sm text-slate-600">
                            Download the Arduino code and fill in the Wi-Fi
                            name and password before uploading.
                        </p>
                    </div>
                </div>

                <div className="mt-6 flex gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex-1 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                        Close
                    </button>
                    <a
                        href={downloadUrl}
                        download
                        autoFocus
                        className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-center text-sm font-medium text-white hover:bg-slate-700"
                    >
                        ⬇ Download code
                    </a>
                </div>
            </div>
        </div>
    );
}

async function postJson(url: string, body: unknown) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || "Request failed");
    }

    return data;
}

const inputClass =
    "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500";

const buttonClass =
    "rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";

export default function AdminPage() {
    const router = useRouter();

    const [authChecked, setAuthChecked] = useState(false);

    const [users, setUsers] = useState<User[]>([]);
    const [devices, setDevices] = useState<Device[]>([]);
    const [sensors, setSensors] = useState<Sensor[]>([]);
    const [loadError, setLoadError] = useState("");

    const [search, setSearch] = useState("");
    const [expandedUser, setExpandedUser] = useState<string | null>(null);

    const loadData = useCallback(async () => {
        const response = await fetch("/api/admin/users");

        if (response.status === 401) {
            router.replace("/");
            return;
        }

        const result = await response.json();

        if (!response.ok) {
            setLoadError(result.error || "Failed to load data");
            return;
        }

        setLoadError("");
        setUsers(result.users || []);
        setDevices(result.devices || []);
        setSensors(result.sensors || []);
        setAuthChecked(true);
    }, [router]);

    useEffect(() => {
        // Prvo ucitavanje + osvjezavanje statusa svakih 30s.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadData();

        const interval = setInterval(loadData, 30000);

        return () => clearInterval(interval);
    }, [loadData]);

    async function handleLogout() {
        await fetch("/api/admin/logout", { method: "POST" });
        localStorage.removeItem("user");
        router.replace("/");
    }

    const sensorTypes = useMemo(() => {
        const types = new Set(sensors.map((s) => s.type).filter(Boolean));
        types.add(DEFAULT_SENSOR_TYPE);

        return [...types];
    }, [sensors]);

    const filteredUsers = useMemo(() => {
        const query = search.trim().toLowerCase();

        if (!query) return users;

        return users.filter(
            (u) =>
                u.name?.toLowerCase().includes(query) ||
                u.email?.toLowerCase().includes(query)
        );
    }, [users, search]);

    const onlineDevices = devices.filter((d) =>
        isDeviceOnline(d.last_seen)
    ).length;

    if (!authChecked) {
        return (
            <main className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-500">
                {loadError || "Loading..."}
            </main>
        );
    }

    return (
        <main className="min-h-screen bg-slate-50 text-slate-900">

            {/* HEADER */}
            <header className="border-b border-slate-200 bg-white">
                <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-5 sm:px-8">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">
                            Smart Irrigation
                        </h1>
                        <p className="mt-1 text-sm text-slate-500">
                            Admin panel
                        </p>
                    </div>

                    <button
                        onClick={handleLogout}
                        className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                        Log out
                    </button>
                </div>
            </header>

            <div className="mx-auto max-w-7xl px-4 py-8 sm:px-8">

                {loadError && (
                    <div className="mb-6 rounded-lg bg-red-100 px-4 py-3 text-sm text-red-700">
                        {loadError}
                    </div>
                )}

                {/* STATISTICS */}
                <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
                    <StatCard label="Users" value={users.length} />
                    <StatCard label="Devices" value={devices.length} />
                    <StatCard
                        label="Devices online"
                        value={`${onlineDevices} / ${devices.length}`}
                        highlight
                    />
                    <StatCard label="Sensors" value={sensors.length} />
                </div>

                <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

                    {/* NEW USER */}
                    <div className="lg:col-span-1">
                        <NewUserForm onCreated={loadData} />
                    </div>

                    {/* USERS OVERVIEW */}
                    <div className="lg:col-span-2">
                        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">

                            <div className="flex flex-col gap-3 border-b border-slate-100 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <h2 className="text-lg font-bold">
                                        Users
                                    </h2>
                                    <p className="mt-1 text-sm text-slate-500">
                                        Click a user to manage devices and
                                        sensors.
                                    </p>
                                </div>

                                <input
                                    value={search}
                                    onChange={(e) =>
                                        setSearch(e.target.value)
                                    }
                                    placeholder="Search by name or email"
                                    className={`${inputClass} sm:w-64`}
                                />
                            </div>

                            {filteredUsers.length === 0 && (
                                <p className="px-6 py-10 text-center text-sm text-slate-500">
                                    No users found.
                                </p>
                            )}

                            <ul className="divide-y divide-slate-100">
                                {filteredUsers.map((user) => {
                                    const userDevices = devices.filter(
                                        (d) => d.user_id === user.id
                                    );
                                    const userSensorCount = sensors.filter(
                                        (s) =>
                                            userDevices.some(
                                                (d) => d.id === s.device_id
                                            )
                                    ).length;
                                    const lastSeen = userDevices
                                        .map((d) => d.last_seen)
                                        .filter(
                                            (v): v is string => v !== null
                                        )
                                        .sort()
                                        .at(-1) ?? null;
                                    const isExpanded =
                                        expandedUser === user.id;

                                    return (
                                        <li key={user.id}>
                                            <button
                                                onClick={() =>
                                                    setExpandedUser(
                                                        isExpanded
                                                            ? null
                                                            : user.id
                                                    )
                                                }
                                                className="flex w-full flex-col gap-3 px-6 py-4 text-left hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between"
                                            >
                                                <div className="min-w-0">
                                                    <p className="font-semibold">
                                                        {user.name}
                                                    </p>
                                                    <p className="truncate text-sm text-slate-500">
                                                        {user.email}
                                                    </p>
                                                </div>

                                                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                                                    <span>
                                                        {userDevices.length}{" "}
                                                        devices ·{" "}
                                                        {userSensorCount}{" "}
                                                        sensors
                                                    </span>
                                                    <span>
                                                        Last seen:{" "}
                                                        {formatLastSeen(
                                                            lastSeen
                                                        )}
                                                    </span>
                                                    <StatusBadge
                                                        status={getUserStatus(
                                                            userDevices
                                                        )}
                                                    />
                                                    <span className="text-slate-400">
                                                        {isExpanded
                                                            ? "▲"
                                                            : "▼"}
                                                    </span>
                                                </div>
                                            </button>

                                            {isExpanded && (
                                                <UserDetails
                                                    user={user}
                                                    devices={userDevices}
                                                    sensors={sensors}
                                                    sensorTypes={
                                                        sensorTypes
                                                    }
                                                    onChanged={loadData}
                                                />
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>

                        </div>
                    </div>

                </div>
            </div>
        </main>
    );
}

function StatCard({
    label,
    value,
    highlight = false,
}: {
    label: string;
    value: string | number;
    highlight?: boolean;
}) {
    return (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-medium text-slate-500">{label}</p>
            <p
                className={`mt-3 text-2xl font-bold ${highlight ? "text-emerald-600" : "text-slate-900"}`}
            >
                {value}
            </p>
        </div>
    );
}

function NewUserForm({ onCreated }: { onCreated: () => Promise<void> }) {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [saving, setSaving] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();

        setError("");
        setSuccess("");
        setSaving(true);

        try {
            await postJson("/api/admin/users", { name, email, password });

            setSuccess(`User ${email} created.`);
            setName("");
            setEmail("");
            setPassword("");

            await onCreated();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <form
            onSubmit={handleSubmit}
            className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
        >
            <div>
                <h2 className="text-lg font-bold">New user</h2>
                <p className="mt-1 text-sm text-slate-500">
                    Create an account the user can sign in with.
                </p>
            </div>

            <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                required
                className={inputClass}
            />
            <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                required
                className={inputClass}
            />
            <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                autoComplete="new-password"
                className={inputClass}
            />

            {error && (
                <AlertModal message={error} onClose={() => setError("")} />
            )}
            {success && (
                <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                    {success}
                </p>
            )}

            <button type="submit" disabled={saving} className={`${buttonClass} w-full`}>
                {saving ? "Creating..." : "Create user"}
            </button>
        </form>
    );
}

function UserDetails({
    user,
    devices,
    sensors,
    sensorTypes,
    onChanged,
}: {
    user: User;
    devices: Device[];
    sensors: Sensor[];
    sensorTypes: string[];
    onChanged: () => Promise<void>;
}) {
    return (
        <div className="space-y-4 bg-slate-50 px-6 pb-6 pt-2">

            {devices.length === 0 && (
                <p className="text-sm text-slate-500">
                    This user has no devices yet.
                </p>
            )}

            {devices.map((device) => {
                const deviceSensors = sensors.filter(
                    (s) => s.device_id === device.id
                );
                const online = isDeviceOnline(device.last_seen);

                return (
                    <div
                        key={device.id}
                        className="rounded-xl border border-slate-200 bg-white"
                    >
                        <div className="flex flex-col gap-2 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <p className="font-semibold">
                                    ⚙ {device.name}
                                </p>
                                <p className="font-mono text-xs text-slate-500">
                                    {device.device_code}
                                </p>
                            </div>

                            <div className="flex items-center gap-3 text-xs text-slate-500">
                                <span>
                                    Last seen:{" "}
                                    {formatLastSeen(device.last_seen)}
                                </span>
                                <StatusBadge
                                    status={online ? "online" : "offline"}
                                />
                                <a
                                    href={firmwareUrl("controller", device.id)}
                                    download
                                    className={downloadLinkClass}
                                >
                                    ⬇ Code
                                </a>
                            </div>
                        </div>

                        <div className="px-4 py-3">
                            {deviceSensors.length === 0 ? (
                                <p className="text-sm text-slate-500">
                                    No sensors on this device.
                                </p>
                            ) : (
                                <ul className="space-y-2">
                                    {deviceSensors.map((sensor) => (
                                        <li
                                            key={sensor.id}
                                            className="flex flex-wrap items-center gap-x-3 text-sm"
                                        >
                                            <span>◉ {sensor.name}</span>
                                            <span className="font-mono text-xs text-slate-500">
                                                {sensor.sensor_code}
                                            </span>
                                            <span className="rounded bg-violet-50 px-2 py-0.5 text-xs text-violet-700">
                                                {sensor.type}
                                            </span>
                                            <a
                                                href={firmwareUrl("sensor", sensor.id)}
                                                download
                                                className={`${downloadLinkClass} ml-auto`}
                                            >
                                                ⬇ Code
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            )}

                            <NewSensorForm
                                deviceId={device.id}
                                sensorTypes={sensorTypes}
                                onCreated={onChanged}
                            />
                        </div>
                    </div>
                );
            })}

            <NewDeviceForm userId={user.id} onCreated={onChanged} />
        </div>
    );
}

function NewDeviceForm({
    userId,
    onCreated,
}: {
    userId: string;
    onCreated: () => Promise<void>;
}) {
    const [name, setName] = useState("");
    const [deviceCode, setDeviceCode] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const [created, setCreated] = useState<{ id: string; name: string } | null>(
        null
    );

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();

        setError("");
        setSaving(true);

        try {
            const result = await postJson("/api/admin/devices", {
                user_id: userId,
                name,
                device_code: deviceCode,
            });

            setCreated(result.device);
            setName("");
            setDeviceCode("");

            await onCreated();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <form
            onSubmit={handleSubmit}
            className="rounded-xl border border-dashed border-slate-300 bg-white p-4"
        >
            <p className="mb-3 text-sm font-semibold">Add device</p>

            <div className="flex flex-col gap-2 sm:flex-row">
                <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Device name"
                    required
                    className={inputClass}
                />
                <input
                    value={deviceCode}
                    onChange={(e) => setDeviceCode(e.target.value)}
                    placeholder="Device code (controller ID)"
                    required
                    className={`${inputClass} font-mono`}
                />
                <button type="submit" disabled={saving} className={buttonClass}>
                    {saving ? "Adding..." : "Add"}
                </button>
            </div>

            {error && (
                <AlertModal message={error} onClose={() => setError("")} />
            )}
            {created && (
                <CreatedModal
                    title={`Device "${created.name}" created`}
                    downloadUrl={firmwareUrl("controller", created.id)}
                    onClose={() => setCreated(null)}
                />
            )}
        </form>
    );
}

function NewSensorForm({
    deviceId,
    sensorTypes,
    onCreated,
}: {
    deviceId: string;
    sensorTypes: string[];
    onCreated: () => Promise<void>;
}) {
    const [name, setName] = useState("");
    const [sensorCode, setSensorCode] = useState("");
    const [type, setType] = useState(DEFAULT_SENSOR_TYPE);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const [created, setCreated] = useState<{ id: string; name: string } | null>(
        null
    );

    const listId = `sensor-types-${deviceId}`;

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();

        setError("");
        setSaving(true);

        try {
            const result = await postJson("/api/admin/sensors", {
                device_id: deviceId,
                name,
                sensor_code: sensorCode,
                type,
            });

            setCreated(result.sensor);
            setName("");
            setSensorCode("");

            await onCreated();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="mt-3 border-t border-slate-100 pt-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Add sensor
            </p>

            <div className="flex flex-col gap-2 sm:flex-row">
                <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Sensor name"
                    required
                    className={inputClass}
                />
                <input
                    value={sensorCode}
                    onChange={(e) => setSensorCode(e.target.value)}
                    placeholder="Sensor code"
                    required
                    className={`${inputClass} font-mono`}
                />
                <input
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    placeholder="Type"
                    list={listId}
                    required
                    className={`${inputClass} sm:w-40`}
                />
                <datalist id={listId}>
                    {sensorTypes.map((t) => (
                        <option key={t} value={t} />
                    ))}
                </datalist>
                <button type="submit" disabled={saving} className={buttonClass}>
                    {saving ? "Adding..." : "Add"}
                </button>
            </div>

            {error && (
                <AlertModal message={error} onClose={() => setError("")} />
            )}
            {created && (
                <CreatedModal
                    title={`Sensor "${created.name}" created`}
                    downloadUrl={firmwareUrl("sensor", created.id)}
                    onClose={() => setCreated(null)}
                />
            )}
        </form>
    );
}
