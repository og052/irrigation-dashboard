import { readFile } from "fs/promises";
import path from "path";

export type FirmwareKind = "controller" | "sensor";

const TEMPLATE_FILES: Record<FirmwareKind, string> = {
    controller: "controller.ino.template",
    sensor: "sensor.ino.template",
};

/*
 * Vrijednosti idu unutar C string literala ("..."), pa
 * escapujemo \ i " i izbacujemo nove redove.
 */
function escapeForC(value: string) {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/[\r\n]+/g, " ");
}

/*
 * Ucitava sablon iz firmware/ foldera i zamjenjuje {{KLJUC}}
 * oznake. Nepoznate oznake ostaju netaknute.
 */
export async function renderFirmware(
    kind: FirmwareKind,
    values: Record<string, string>
) {
    const templatePath = path.join(
        process.cwd(),
        "firmware",
        TEMPLATE_FILES[kind]
    );

    const template = await readFile(templatePath, "utf8");

    const allValues: Record<string, string> = {
        WIFI_SSID: "YOUR_WIFI_SSID",
        WIFI_PASSWORD: "YOUR_WIFI_PASSWORD",
        GENERATED_AT: new Date().toISOString(),
        ...values,
    };

    return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) =>
        key in allValues ? escapeForC(allValues[key]) : match
    );
}

/*
 * Arduino IDE trazi da se .ino nalazi u folderu istog imena,
 * pa ime fajla pravimo od koda (samo sigurni znakovi).
 */
export function sketchFileName(code: string) {
    const safe = code.replace(/[^A-Za-z0-9_-]+/g, "_") || "sketch";

    return `${safe}.ino`;
}
