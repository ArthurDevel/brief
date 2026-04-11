/**
 * Public entry page for short-lived session recap review links.
 *
 * Valid tokens render a minimal unauthenticated review page. Authenticated
 * owners are redirected to the normal dashboard session page.
 *
 * Responsibilities:
 * - Validate the review token before rendering
 * - Redirect authenticated owners to the dashboard
 * - Render the minimal token-backed review UI for unauthenticated users
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import { validateSessionReviewToken } from "@/lib/session-review-tokens";
import ReviewSessionClient from "./ReviewSessionClient";

// ============================================================================
// TYPES
// ============================================================================

interface ReviewSessionPageProps {
  searchParams: Promise<{
    token?: string;
    focusActionId?: string;
  }>;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Validates the session review token and routes users to the right review UI.
 * @param props - Page props with query params
 * @returns Minimal review page for unauthenticated valid-token users
 */
export default async function ReviewSessionPage(
  props: ReviewSessionPageProps
) {
  const searchParams = await props.searchParams;
  const token = searchParams.token ?? "";

  if (!token) {
    redirect("/login");
  }

  const serviceClient = createServiceRoleClient();
  const tokenContext = await validateSessionReviewToken(serviceClient, token);
  if (!tokenContext) {
    redirect("/login");
  }

  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (user?.id === tokenContext.userId) {
    redirect(`/dashboard/sessions/${tokenContext.sessionId}`);
  }

  if (user && user.id !== tokenContext.userId) {
    redirect("/dashboard");
  }

  return (
    <ReviewSessionClient
      token={token}
      focusActionId={searchParams.focusActionId ?? null}
    />
  );
}
