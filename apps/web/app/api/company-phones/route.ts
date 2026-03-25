/**
 * API route for fetching company phone numbers.
 *
 * Returns all active company phone numbers for the current environment.
 * These are the Twilio numbers the company uses for outbound calls and
 * caller ID matching per country.
 *
 * Responsibilities:
 * - Authenticate the request via Supabase session
 * - Query company_phone_numbers filtered by environment and is_active
 * - Return as CompanyPhone[]
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import type { CompanyPhone } from "@/lib/types";

const APP_ENVIRONMENT = process.env.NEXT_PUBLIC_APP_ENVIRONMENT ?? "prod";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Fetches all active company phone numbers for the current environment.
 * @param _request - The incoming request (unused)
 * @returns JSON array of CompanyPhone objects
 */
export async function GET(_request: NextRequest): Promise<NextResponse<CompanyPhone[] | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" } as unknown as CompanyPhone[], { status: 401 });
  }

  const { data, error } = await supabase
    .from("company_phone_numbers")
    .select("id, phone_number, label, country_code, environment")
    .eq("is_active", true)
    .eq("environment", APP_ENVIRONMENT);

  if (error) {
    return NextResponse.json({ error: error.message } as unknown as CompanyPhone[], { status: 500 });
  }

  const phones: CompanyPhone[] = (data ?? []).map((row) => ({
    id: row.id,
    phoneNumber: row.phone_number,
    label: row.label,
    countryCode: row.country_code,
    environment: row.environment,
  }));

  return NextResponse.json(phones);
}
