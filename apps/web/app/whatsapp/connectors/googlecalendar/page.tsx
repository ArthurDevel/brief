/**
 * WhatsApp-scoped Google Calendar connector page.
 *
 * Responsibilities:
 * - Stay inside the existing /whatsapp auth shell
 * - Load the signed-in user's Google Calendar connection summary
 * - Render the Google Calendar connect CTA and any callback notices
 */

import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { getWhatsAppConnectorConnectionSummary } from "@/lib/composio";
import { getWhatsAppProfile } from "@/lib/whatsapp-auth";
import ComposioConnectorCard from "../ComposioConnectorCard";
import { getWhatsAppConnectorDefinition } from "../connectorDefinitions";
import { getConnectorNotice } from "../connectorLogic";

// ============================================================================
// TYPES
// ============================================================================

interface GoogleCalendarConnectorPageProps {
  searchParams: Promise<{
    connected?: string;
    error?: string;
  }>;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Loads the current Google Calendar connection state for the signed-in WhatsApp user.
 * @param props - Page search params used for success and error notices
 * @returns Google Calendar connector page inside the WhatsApp layout
 */
export default async function GoogleCalendarConnectorPage(
  props: GoogleCalendarConnectorPageProps
) {
  const definition = getWhatsAppConnectorDefinition("googlecalendar");
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
    getWhatsAppConnectorConnectionSummary(user.id, "googlecalendar"),
  ]);

  return (
    <ComposioConnectorCard
      connection={connection}
      definition={definition}
      notice={getConnectorNotice(definition, searchParams)}
      whatsappPhone={profile.whatsappPhone ?? profile.authPhone}
    />
  );
}
