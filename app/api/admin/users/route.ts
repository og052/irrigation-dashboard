import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { ADMIN_EMAIL, isAdminEmail, isAdminRequest } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

function unauthorized() {
    return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
    );
}

// Pregled svih korisnika sa njihovim uređajima i senzorima.
export async function GET() {
    if (!(await isAdminRequest())) {
        return unauthorized();
    }

    const [usersResult, devicesResult, sensorsResult] = await Promise.all([
        supabase
            .from("users")
            .select("id, name, email")
            .neq("email", ADMIN_EMAIL)
            .order("name", { ascending: true }),
        supabase
            .from("devices")
            .select("id, name, device_code, last_seen, user_id"),
        supabase
            .from("sensors")
            .select("id, name, sensor_code, type, device_id"),
    ]);

    const error =
        usersResult.error || devicesResult.error || sensorsResult.error;

    if (error) {
        console.error("ADMIN USERS ERROR:", error);

        return NextResponse.json(
            { error: error.message },
            { status: 500 }
        );
    }

    return NextResponse.json({
        users: usersResult.data,
        devices: devicesResult.data,
        sensors: sensorsResult.data,
    });
}

// Kreiranje novog korisnika.
export async function POST(request: Request) {
    if (!(await isAdminRequest())) {
        return unauthorized();
    }

    try {
        const body = await request.json();

        const name = String(body.name ?? "").trim();
        const email = String(body.email ?? "").trim();
        const password = String(body.password ?? "");

        if (!name || !email || !password) {
            return NextResponse.json(
                { error: "Name, email and password are required" },
                { status: 400 }
            );
        }

        if (isAdminEmail(email)) {
            return NextResponse.json(
                { error: "This email is reserved" },
                { status: 400 }
            );
        }

        const { data: existing, error: existingError } = await supabase
            .from("users")
            .select("id")
            .eq("email", email)
            .maybeSingle();

        if (existingError) {
            throw existingError;
        }

        if (existing) {
            return NextResponse.json(
                { error: "A user with this email already exists" },
                { status: 409 }
            );
        }

        const { data: user, error } = await supabase
            .from("users")
            .insert({ name, email, password })
            .select("id, name, email")
            .single();

        if (error) {
            throw error;
        }

        return NextResponse.json({ success: true, user });
    } catch (error) {
        console.error("ADMIN CREATE USER ERROR:", error);

        return NextResponse.json(
            {
                error:
                    (error as { message?: string })?.message ??
                    "Invalid request",
            },
            { status: 500 }
        );
    }
}
