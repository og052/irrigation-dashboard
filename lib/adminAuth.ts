import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { supabase } from "@/lib/supabase";

// Admin je obican red u tabeli users sa ovim emailom.
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@admin";

export const ADMIN_COOKIE = "admin_session";

const SESSION_SECONDS = 60 * 60 * 12;

type AdminUser = {
    id: string;
    email: string;
    password: string;
};

async function getAdminUser(): Promise<AdminUser | null> {
    const { data, error } = await supabase
        .from("users")
        .select("id, email, password")
        .eq("email", ADMIN_EMAIL)
        .maybeSingle();

    if (error || !data) {
        return null;
    }

    return data as AdminUser;
}

/*
 * Token je "expires.signature". Kljuc za potpis ukljucuje admin
 * lozinku, pa promjena lozinke u bazi ponistava sve sesije.
 * ADMIN_SESSION_SECRET (opciono) dodatno ojacava kljuc.
 */
function sign(admin: AdminUser, expires: number) {
    const key =
        (process.env.ADMIN_SESSION_SECRET ?? "") +
        admin.id +
        admin.password;

    return createHmac("sha256", key)
        .update(`${admin.id}.${expires}`)
        .digest("hex");
}

export function createAdminToken(admin: AdminUser) {
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;

    return `${expires}.${sign(admin, expires)}`;
}

export async function setAdminCookie(admin: AdminUser) {
    const cookieStore = await cookies();

    cookieStore.set(ADMIN_COOKIE, createAdminToken(admin), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: SESSION_SECONDS,
    });
}

export async function clearAdminCookie() {
    const cookieStore = await cookies();
    cookieStore.delete(ADMIN_COOKIE);
}

/*
 * Vraca true ako zahtjev ima validan admin cookie.
 */
export async function isAdminRequest() {
    const cookieStore = await cookies();
    const token = cookieStore.get(ADMIN_COOKIE)?.value;

    if (!token) {
        return false;
    }

    const [expiresText, signature] = token.split(".");
    const expires = Number(expiresText);

    if (
        !signature ||
        !Number.isInteger(expires) ||
        expires < Date.now() / 1000
    ) {
        return false;
    }

    const admin = await getAdminUser();

    if (!admin) {
        return false;
    }

    const expected = Buffer.from(sign(admin, expires));
    const actual = Buffer.from(signature);

    return (
        expected.length === actual.length &&
        timingSafeEqual(expected, actual)
    );
}

export function isAdminEmail(email: string) {
    return email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
}
