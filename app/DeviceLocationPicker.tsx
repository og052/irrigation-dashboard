"use client";

import { useState } from "react";
import {
    MapContainer,
    TileLayer,
    Marker,
    useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { supabase } from "@/lib/supabase";

/*
 * Default marker icon as a plain SVG DivIcon instead of
 * leaflet's default PNG icons - those break under Next.js/
 * webpack bundling unless you manually copy image assets.
 */
const markerIcon = L.divIcon({
    className: "",
    html: `
        <svg width="28" height="28" viewBox="0 0 24 24"
             fill="#2563eb" stroke="white" stroke-width="1.5">
            <path d="M12 2C7.58 2 4 5.58 4 10c0 5.25 7 12 8 12s8-6.75 8-12c0-4.42-3.58-8-8-8zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/>
        </svg>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
});

/*
 * Rough regional default for a first-time pick, so the map
 * doesn't open at 0,0 (middle of the ocean). Adjust to taste.
 */
const DEFAULT_CENTER: [number, number] = [43.8563, 18.4131]; // Sarajevo
const DEFAULT_ZOOM = 7;
const PICKED_ZOOM = 12;

function ClickHandler({
    onPick,
}: {
    onPick: (lat: number, lng: number) => void;
}) {
    useMapEvents({
        click(e) {
            onPick(e.latlng.lat, e.latlng.lng);
        },
    });

    return null;
}

type Props = {
    deviceId: string;
    initialLatitude: number | null;
    initialLongitude: number | null;
    onSaved: (latitude: number, longitude: number) => void;
    onClose?: () => void;
};

export default function DeviceLocationPicker({
    deviceId,
    initialLatitude,
    initialLongitude,
    onSaved,
    onClose,
}: Props) {
    const hasInitial =
        initialLatitude !== null && initialLongitude !== null;

    const [position, setPosition] = useState<
        [number, number] | null
    >(hasInitial ? [initialLatitude!, initialLongitude!] : null);

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSave() {
        if (!position) return;

        setSaving(true);
        setError(null);

        const [latitude, longitude] = position;

        const { error: updateError } = await supabase
            .from("devices")
            .update({ latitude, longitude })
            .eq("id", deviceId);

        setSaving(false);

        if (updateError) {
            console.error(
                "Error saving device location:",
                updateError
            );
            setError("Could not save location. Try again.");
            return;
        }

        onSaved(latitude, longitude);
    }

    return (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">

            <div className="mb-3 flex items-center justify-between">

                <div>
                    <p className="font-semibold text-slate-900">
                        Set device location
                    </p>

                    <p className="text-xs text-slate-500">
                        Click on the map to place a marker, then save.
                    </p>
                </div>

                {onClose && (
                    <button
                        onClick={onClose}
                        className="text-xs text-slate-400 hover:text-slate-600"
                    >
                        Close
                    </button>
                )}

            </div>

            <div className="h-72 w-full overflow-hidden rounded-xl border border-slate-200">
                <MapContainer
                    center={position ?? DEFAULT_CENTER}
                    zoom={position ? PICKED_ZOOM : DEFAULT_ZOOM}
                    style={{ width: "100%", height: "100%" }}
                >
                    <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />

                    <ClickHandler
                        onPick={(lat, lng) => setPosition([lat, lng])}
                    />

                    {position && (
                        <Marker position={position} icon={markerIcon} />
                    )}
                </MapContainer>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">

                <p className="text-xs text-slate-500">
                    {position
                        ? `${position[0].toFixed(5)}, ${position[1].toFixed(5)}`
                        : "No location picked yet"}
                </p>

                <button
                    onClick={handleSave}
                    disabled={!position || saving}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving ? "Saving..." : "Save location"}
                </button>

            </div>

            {error && (
                <p className="mt-2 text-xs text-red-600">{error}</p>
            )}

        </div>
    );
}