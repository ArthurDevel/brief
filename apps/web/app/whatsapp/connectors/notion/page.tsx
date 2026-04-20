/**
 * WhatsApp-scoped Notion connector page.
 *
 * Responsibilities:
 * - Stay inside the existing /whatsapp auth shell
 * - Load the signed-in user's Notion connection summary
 * - Render the Notion connect CTA and any callback notices
 */

import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { getUserComposioConnection } from "@/lib/composio-connections";
import { getWhatsAppProfile } from "@/lib/whatsapp-auth";
import ComposioConnectorCard from "../ComposioConnectorCard";
import { getWhatsAppConnectorDefinition } from "../connectorDefinitions";
import { getConnectorNotice } from "../connectorLogic";

// ============================================================================
// TYPES
// ============================================================================

interface NotionConnectorPageProps {
  searchParams: Promise<{
    connected?: string;
    error?: string;
  }>;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Loads the current Notion connection state for the signed-in WhatsApp user.
 * @param props - Page search params used for success and error notices
 * @returns Notion connector page inside the WhatsApp layout
 */
export default async function NotionConnectorPage(
  props: NotionConnectorPageProps
) {
  const definition = getWhatsAppConnectorDefinition("notion");
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
    getUserComposioConnection(supabase, user.id, "notion"),
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
