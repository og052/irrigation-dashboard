import { supabase } from "@/lib/supabase";

/*
 * Provjera da li je ime vec zauzeto u tabeli (bez obzira na velika/mala
 * slova i razmake na krajevima). Poredimo u JS-u da izbjegnemo
 * wildcard znakove (% _ *) u ilike upitu.
 */
export async function isNameTaken(
    table: "devices" | "sensors",
    name: string
) {
    const { data, error } = await supabase.from(table).select("name");

    if (error) {
        throw error;
    }

    const normalized = name.trim().toLowerCase();

    return (data ?? []).some(
        (row) => String(row.name ?? "").trim().toLowerCase() === normalized
    );
}
