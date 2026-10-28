import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { isAdminEmail, setAdminCookie } from "@/lib/adminAuth";

export async function POST(request: Request) {
    try {
        const { email, password } = await request.json();

        if (!email || !password) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Email and password are required",
                },
                { status: 400 }
            );
        }

        const { data: user, error } = await supabase
            .from("users")
            .select("id, name, email, password")
            .eq("email", email)
            .eq("password", password)
            .single();

        if (error || !user) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Invalid email or password",
                },
                { status: 401 }
            );
        }

        const isAdmin = isAdminEmail(user.email);

        // Admin dobija httpOnly cookie za /admin panel.
        if (isAdmin) {
            await setAdminCookie(user);
        }

        return NextResponse.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
            },
            isAdmin,
        });

    } catch (error) {
        console.error("LOGIN ERROR:", error);

        return NextResponse.json(
            {
                success: false,
                error: "Invalid request",
            },
            { status: 400 }
        );
    }
}