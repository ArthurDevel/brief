/**
 * WhatsApp-scoped Gmail connector page.
 *
 * Responsibilities:
 * - Stay inside the existing /whatsapp auth shell
 * - Load the signed-in user's Gmail connection summary
 * - Render the Gmail connect CTA and any callback notices
 */

import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { getUserComposioConnection } from "@/lib/composio-connections";
import { getWhatsAppProfile } from "@/lib/whatsapp-auth";
import GmailConnectorCard from "./GmailConnectorCard";
import { getGmailConnectorNotice } from "./logic";

// ============================================================================
// TYPES
// ============================================================================

interface GmailConnectorPageProps {
  searchParams: Promise<{
    connected?: string;
    error?: string;
  }>;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Loads the current Gmail connection state for the signed-in WhatsApp user.
 * @param props - Page search params used for success/error notices
 * @returns Gmail connector page inside the WhatsApp layout
 */
export default async function GmailConnectorPage(
  props: GmailConnectorPageProps
) {
  const searchParams = await props.searchParams;
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const [profile, connection] = await Promise.all([
    getWhatsAppProfile(supabase, user),
    getUserComposioConnection(supabase, user.id, "gmail"),
  ]);

  return (
    <GmailConnectorCard
      connection={connection}
      notice={getGmailConnectorNotice(searchParams)}
      whatsappPhone={profile.whatsappPhone ?? profile.authPhone}
    />
  );
}
