/**
 * API route for WhatsApp end-of-session processing.
 *
 * Responsibilities:
 * - Authenticate via INTERNAL_API_KEY (service-to-service)
 * - Load a finalized WhatsApp session from the sessions table
 * - Fetch current LiveKit public pricing
 * - Calculate and persist cost_usd from stored model usage
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/client";
import {
  calculateSessionCostUsd,
  getLiveKitPricing,
  type SessionModelUsage
} from "@/lib/livekitPricing";

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
 * Calculates and stores cost_usd for a completed WhatsApp session.
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

    return NextResponse.json({ costUsd });
  } catch (error) {
    console.error("[whatsapp-end-of-session] failed to calculate cost", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      { error: "Failed to calculate session cost" },
      { status: 500 }
    );
  }
}
