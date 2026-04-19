/**
 * Email verified trigger logic.
 *
 * Handles the idempotent claim-before-send flow for the immediate
 * post-verification transactional email.
 *
 * Responsibilities:
 * - Claim the email_events row before sending
 * - Treat duplicate claims as safe no-op success
 * - Send the email_verified template through Resend
 * - Store the Resend email ID or clean up the claim on send failure
 */

import type { PostgrestError } from "@supabase/supabase-js";
import { sendEngagementEmail } from "@/lib/resend/client";
import { getEngagementEmailContent } from "@/lib/engagement/catalog";
import { createServiceRoleClient } from "@/lib/supabase/client";

// ============================================================================
// TYPES
// ============================================================================

export type EmailVerifiedTriggerStatus = "sent" | "already_sent";

interface TriggerEmailVerifiedParams {
  /** Service role Supabase client */
  supabase: ReturnType<typeof createServiceRoleClient>;
  /** Auth user UUID */
  userId: string;
  /** Confirmed auth email address */
  email: string;
  /** Lander base URL used by shared template APIs */
  landerUrl: string;
  /** App base URL used in the CTA */
  appUrl: string;
}

interface EmailEventClaim {
  /** Claimed email_events row ID */
  id: string;
  /** Whether this request created the claim */
  claimed: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const EMAIL_TYPE = "email_verified";
const UNIQUE_VIOLATION_CODE = "23505";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Sends the email_verified engagement email exactly once for a user.
 * @param params - Verified user identity and shared service dependencies
 * @returns "sent" when a new email is sent, or "already_sent" when deduped
 */
export async function triggerEmailVerifiedEmail(
  params: TriggerEmailVerifiedParams
): Promise<EmailVerifiedTriggerStatus> {
  const claim = await claimEmailEvent(params.supabase, params.userId);
  if (!claim.claimed) {
    console.log(`[email-verified] Duplicate trigger ignored for user ${params.userId}`);
    return "already_sent";
  }

  const content = getEngagementEmailContent(
    EMAIL_TYPE,
    params.landerUrl,
    params.appUrl
  );

  let resendEmailId: string | null = null;

  try {
    resendEmailId = await sendEngagementEmail(params.email, content);

    if (!resendEmailId) {
      throw new Error("Resend did not return an email ID");
    }
  } catch (error) {
    await deleteEmailEventClaim(params.supabase, claim.id);
    throw error;
  }

  await storeResendEmailId(params.supabase, claim.id, resendEmailId);

  console.log(
    `[email-verified] Sent email_verified to ${params.email}, resend_id=${resendEmailId}`
  );

  return "sent";
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Claims the email_events row for email_verified.
 * @param supabase - Service role Supabase client
 * @param userId - Auth user UUID
 * @returns The claimed row ID, or a no-op result when already sent
 */
async function claimEmailEvent(
  supabase: ReturnType<typeof createServiceRoleClient>,
  userId: string
): Promise<EmailEventClaim> {
  const { data, error } = await supabase
    .from("email_events")
    .insert({
      user_id: userId,
      email_type: EMAIL_TYPE,
      resend_email_id: null,
    })
    .select("id")
    .single();

  if (error) {
    if (isDuplicateEmailEventError(error)) {
      return { id: "", claimed: false };
    }

    throw new Error(`Failed to claim email_verified send: ${error.message}`);
  }

  if (!data?.id) {
    throw new Error("Failed to claim email_verified send: missing row ID");
  }

  return { id: data.id, claimed: true };
}

/**
 * Persists the Resend email ID on the claimed email_events row.
 * @param supabase - Service role Supabase client
 * @param claimId - Claimed email_events row ID
 * @param resendEmailId - Resend email ID from the send response
 * @returns Promise that resolves when the row is updated
 */
async function storeResendEmailId(
  supabase: ReturnType<typeof createServiceRoleClient>,
  claimId: string,
  resendEmailId: string
): Promise<void> {
  const { error } = await supabase
    .from("email_events")
    .update({ resend_email_id: resendEmailId })
    .eq("id", claimId);

  if (error) {
    throw new Error(`Failed to store Resend email ID: ${error.message}`);
  }
}

/**
 * Deletes a previously claimed email_events row after a send failure.
 * @param supabase - Service role Supabase client
 * @param claimId - Claimed email_events row ID
 * @returns Promise that resolves when cleanup completes
 */
async function deleteEmailEventClaim(
  supabase: ReturnType<typeof createServiceRoleClient>,
  claimId: string
): Promise<void> {
  const { error } = await supabase
    .from("email_events")
    .delete()
    .eq("id", claimId);

  if (error) {
    console.error(
      `[email-verified] Failed to clean up claim ${claimId}: ${error.message}`
    );
  }
}

/**
 * Checks whether a Postgres error represents the unique email_events constraint.
 * @param error - Supabase/PostgREST error object
 * @returns True when the insert failed because the row already exists
 */
export function isDuplicateEmailEventError(error: PostgrestError): boolean {
  return error.code === UNIQUE_VIOLATION_CODE;
}
