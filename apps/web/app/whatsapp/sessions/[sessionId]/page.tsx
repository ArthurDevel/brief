/**
 * WhatsApp session detail page.
 *
 * Responsibilities:
 * - Reuse the existing session detail UI for WhatsApp session links
 * - Verify the logged-in user owns the linked session
 * - Show a clear mismatch state when the wrong WhatsApp account is signed in
 */

import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import DashboardSessionDetailPage from "@/app/dashboard/sessions/[sessionId]/page";
import WhatsAppSignOutButton from "@/app/whatsapp/_components/WhatsAppSignOutButton";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { maskWhatsAppPhone } from "@/lib/whatsapp-auth";
import { getWhatsAppSessionAccess } from "@/lib/whatsapp-session-access";

// ============================================================================
// TYPES
// ============================================================================

interface WhatsAppSessionPageProps {
  params: Promise<{
    sessionId: string;
  }>;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Renders one WhatsApp session after validating ownership.
 * @param props - Page props containing the session ID
 * @returns Session detail UI or an ownership warning
 */
export default async function WhatsAppSessionPage(
  props: WhatsAppSessionPageProps
) {
  const { sessionId } = await props.params;
  const sessionAccess = await getWhatsAppSessionAccess(sessionId);

  if (!sessionAccess) {
    notFound();
  }

  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  if (user.id !== sessionAccess.userId) {
    return (
      <section className="settings-panel max-w-2xl">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--text-secondary)]">
          WhatsApp Session
        </div>
        <h1 className="mt-2 text-[28px] font-semibold text-[var(--text-primary)]">
          Wrong WhatsApp account
        </h1>
        <p className="mt-3 text-[14px] leading-6 text-[var(--text-secondary)]">
          This session belongs to the WhatsApp account linked to{" "}
          <span className="font-medium text-[var(--text-primary)]">
            {maskWhatsAppPhone(sessionAccess.whatsappPhone)}
          </span>.
          Log out, then open the link again to receive the correct code.
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <WhatsAppSignOutButton />
        </div>
      </section>
    );
  }

  return <DashboardSessionDetailPage />;
}
