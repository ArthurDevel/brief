/**
 * Supabase auth callback handler.
 *
 * Exchanges the auth code from the URL for a session, then redirects
 * the user to the dashboard. This is called by Supabase after email
 * confirmation or OAuth flows.
 *
 * Responsibilities:
 * - Exchange the auth code for a session
 * - Redirect to /dashboard on success
 * - Redirect to /login on error
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Handles the Supabase auth callback by exchanging the code for a session.
 * @param request - The incoming request with the auth code in the URL
 * @returns Redirect to /dashboard or /login
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login`);
  }

  // Ensure the user has a subscription row (created on first login)
  if (data.user) {
    await supabase
      .from("subscriptions")
      .upsert({ user_id: data.user.id, plan: "free" }, { onConflict: "user_id" });
  }

  return NextResponse.redirect(`${origin}/dashboard`);
}
