/**
 * API route for WhatsApp end-of-session processing.
 *
 * Responsibilities:
 * - Authenticate via INTERNAL_API_KEY (service-to-service)
 * - Load a finalized WhatsApp session from the sessions table
 * - Calculate and persist cost_usd from stored model usage when possible
 * - Send the WhatsApp session link template after the call
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/client";
import {
  calculateSessionCostUsd,
  getLiveKitPricing,
  type SessionModelUsage
} from "@/lib/livekitPricing";
import {
  getWhatsAppMessagingConfig,
  sendWhatsAppSessionLinkTemplate,
} from "@/lib/whatsapp-messaging";
import { getWhatsAppSessionAccess } from "@/lib/whatsapp-session-access";

// ============================================================================
// TYPES
// ============================================================================

interface WhatsAppEndOfSessionResult {
  costUsd: number;
}

// ============================================================================
// ENDPOINT
// ============================================================================

/**
 * Calculates cost and sends the WhatsApp session link for a completed session.
 * @param request - Incoming authenticated service request
 * @param context - Route params containing the session ID
 * @returns JSON response with the calculated cost
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<WhatsAppEndOfSessionResult | { error: string }>> {
  const apiKey = process.env.INTERNAL_API_KEY;
  if (!apiKey) {
    throw new Error("INTERNAL_API_KEY is not set");
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || authHeader !== `Bearer ${apiKey}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;
  const supabase = createServiceRoleClient();

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id, ended_at, duration_seconds, model_usage")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (!session.ended_at) {
    return NextResponse.json(
      { error: "Session has not ended yet" },
      { status: 400 }
    );
  }

  const durationSeconds = typeof session.duration_seconds === "number"
    ? session.duration_seconds
    : 0;
  const modelUsage = Array.isArray(session.model_usage)
    ? session.model_usage as SessionModelUsage[]
    : [];

  try {
    const sessionAccess = await getWhatsAppSessionAccess(sessionId);

    if (!sessionAccess) {
      throw new Error("WhatsApp session owner could not be resolved");
    }

    const costUsd = await updateSessionCostBestEffort(
      supabase,
      sessionId,
      modelUsage,
      durationSeconds
    );

    const messagingConfig = getWhatsAppMessagingConfig();
    await sendWhatsAppSessionLinkTemplate(
      messagingConfig,
      sessionAccess.whatsappPhone,
      sessionId
    );

    return NextResponse.json({ costUsd });
  } catch (error) {
    console.error("[whatsapp-end-of-session] failed to process completed session", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      { error: "Failed to process WhatsApp session completion" },
      { status: 500 }
    );
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculates and stores the session cost without blocking the WhatsApp send.
 * @param supabase - Service-role Supabase client
 * @param sessionId - Session ID to update
 * @param modelUsage - Stored LiveKit usage rows
 * @param durationSeconds - Session duration in seconds
 * @returns Calculated cost or 0 when pricing fails
 */
async function updateSessionCostBestEffort(
  supabase: ReturnType<typeof createServiceRoleClient>,
  sessionId: string,
  modelUsage: SessionModelUsage[],
  durationSeconds: number
): Promise<number> {
  try {
    const pricing = await getLiveKitPricing();
    const costUsd = calculateSessionCostUsd(modelUsage, durationSeconds, pricing);

    const { error: updateError } = await supabase
      .from("sessions")
      .update({
        cost_usd: costUsd,
      })
      .eq("id", sessionId);

    if (updateError) {
      throw new Error(`Failed to update session cost: ${updateError.message}`);
    }

    return costUsd;
  } catch (error) {
    console.error("[whatsapp-end-of-session] failed to update session cost", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });

    return 0;
  }
}
