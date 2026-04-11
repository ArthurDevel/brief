/**
 * Helpers for session recap review tokens.
 *
 * Session recap emails include a short-lived bearer token that lets an
 * unauthenticated user review and approve/reject pending actions for exactly
 * one session.
 *
 * Responsibilities:
 * - Create one-hour session review tokens
 * - Store only token hashes in the database
 * - Validate token expiry and revocation
 * - Record token usage timestamps
 */

import { createHash, randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// CONSTANTS
// ============================================================================

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 60 * 60 * 1000;

// ============================================================================
// TYPES
// ============================================================================

export interface SessionReviewTokenContext {
  tokenId: string;
  userId: string;
  sessionId: string;
  expiresAt: string;
}

export interface CreateSessionReviewTokenInput {
  userId: string;
  sessionId: string;
}

export interface CreateSessionReviewTokenResult {
  token: string;
  expiresAt: string;
}

// ============================================================================
// MAIN LOGIC
// ============================================================================

/**
 * Creates and stores a short-lived token for reviewing one session.
 * @param supabase - Service-role Supabase client
 * @param input - User and session IDs to scope the token to
 * @returns The raw token and expiry timestamp
 */
export async function createSessionReviewToken(
  supabase: SupabaseClient,
  input: CreateSessionReviewTokenInput
): Promise<CreateSessionReviewTokenResult> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashSessionReviewToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const { error } = await supabase
    .from("session_review_tokens")
    .insert({
      user_id: input.userId,
      session_id: input.sessionId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

  if (error) {
    throw new Error(`Failed to create session review token: ${error.message}`);
  }

  return { token, expiresAt };
}

/**
 * Hashes a raw session review token for lookup/storage.
 * @param token - Raw token from the email link
 * @returns SHA-256 hex digest
 */
export function hashSessionReviewToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Validates a raw session review token.
 * @param supabase - Service-role Supabase client
 * @param token - Raw token from the request
 * @returns Token context when valid, otherwise null
 */
export async function validateSessionReviewToken(
  supabase: SupabaseClient,
  token: string
): Promise<SessionReviewTokenContext | null> {
  if (!token) {
    return null;
  }

  const tokenHash = hashSessionReviewToken(token);

  const { data, error } = await supabase
    .from("session_review_tokens")
    .select("id, user_id, session_id, expires_at, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to validate session review token: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  if (data.revoked_at) {
    return null;
  }

  const expiresAt = new Date(data.expires_at as string);
  if (expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return {
    tokenId: data.id as string,
    userId: data.user_id as string,
    sessionId: data.session_id as string,
    expiresAt: data.expires_at as string,
  };
}

/**
 * Records that a valid session review token was used.
 * @param supabase - Service-role Supabase client
 * @param tokenId - Token row ID
 * @returns Promise that resolves when the timestamp is updated
 */
export async function touchSessionReviewToken(
  supabase: SupabaseClient,
  tokenId: string
): Promise<void> {
  const { error } = await supabase
    .from("session_review_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tokenId);

  if (error) {
    throw new Error(`Failed to update session review token usage: ${error.message}`);
  }
}
