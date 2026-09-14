import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

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
            .select("id, name, email")
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

        return NextResponse.json({
            success: true,
            user,
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