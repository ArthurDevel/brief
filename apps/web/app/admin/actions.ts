/**
 * Shared server actions for admin functionality.
 *
 * Responsibilities:
 * - Check if the current authenticated user is an admin
 */

"use server";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getCookieOptions } from "@/lib/supabase/client";

// ============================================================================
// CONSTANTS
// ============================================================================

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "").split(",").filter(Boolean);

// ============================================================================
// MAIN ACTIONS
// ============================================================================

/**
 * Checks if the current authenticated user is an admin.
 * @returns true if the user's ID is in ADMIN_USER_IDS
 */
export async function checkIsAdmin(): Promise<boolean> {
  const cookieStore = await cookies();
  const cookieOptions = getCookieOptions();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...(cookieOptions ? { cookieOptions } : {}),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Read-only in server actions
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  return ADMIN_USER_IDS.includes(user.id);
}
