/**
 * Twilio webhook handlers for incoming voice calls.
 *
 * Handles the two-step authentication flow: caller ID lookup followed
 * by DTMF PIN verification. On success, returns TwiML to start a media
 * stream WebSocket connection for the voice AI session.
 *
 * Responsibilities:
 * - handleIncomingCall: look up caller by phone number, prompt for PIN or reject
 * - handleVerifyPin: verify PIN, check usage limits, connect or retry/lock
 * - TwiML builders: generate XML responses for Twilio
 */

import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum PIN attempts before locking the account. */
const MAX_PIN_ATTEMPTS = 3;

/** Number of DTMF digits to collect for PIN. */
const PIN_NUM_DIGITS = 6;

/** Seconds per hour for usage calculations. */
const SECONDS_PER_HOUR = 3600;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Handles an incoming Twilio voice call.
 * Looks up the caller by phone number. If found, prompts for PIN.
 * If not found or locked, plays a rejection message.
 * @param supabase - Supabase client for DB operations
 * @returns Express route handler
 */
export function handleIncomingCall(supabase: SupabaseClient): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const callerPhone = req.body.From as string | undefined;
    console.log(`[twilio] Incoming call from ${callerPhone ?? "unknown"}`);

    if (!callerPhone) {
      res.type("text/xml").send(buildTwimlReject("We could not identify your phone number. Goodbye."));
      return;
    }

    // Look up user by phone number
    const { data: user, error } = await supabase
      .from("user_settings")
      .select("user_id, pin_locked")
      .eq("phone_number", callerPhone)
      .single();

    if (error || !user) {
      console.log(`[twilio] No user found for ${callerPhone}`);
      res.type("text/xml").send(buildTwimlReject("This phone number is not registered. Please sign up in the dashboard."));
      return;
    }

    // Check if account is locked
    if (user.pin_locked) {
      console.log(`[twilio] Account locked for user ${user.user_id}`);
      res.type("text/xml").send(
        buildTwimlReject("Your account is locked. Please set a new PIN in your dashboard.")
      );
      return;
    }

    // Prompt for PIN
    res.type("text/xml").send(buildTwimlGatherPin(user.user_id, 1));
  };
}

/**
 * Handles PIN verification from a Twilio Gather callback.
 * Verifies the DTMF digits against the stored bcrypt hash.
 * On success: checks usage limits, then connects to media stream.
 * On failure: retries up to MAX_PIN_ATTEMPTS, then locks the account.
 * @param supabase - Supabase client for DB operations
 * @param streamBaseUrl - Base WebSocket URL for the media stream (e.g. wss://host)
 * @returns Express route handler
 */
export function handleVerifyPin(
  supabase: SupabaseClient,
  streamBaseUrl: string
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const userId = req.query.userId as string;
    const attempt = parseInt(req.query.attempt as string, 10) || 1;
    const digits = req.body.Digits as string | undefined;

    if (!userId) {
      res.type("text/xml").send(buildTwimlReject("An error occurred. Goodbye."));
      return;
    }

    if (!digits) {
      res.type("text/xml").send(buildTwimlReject("No input received. Goodbye."));
      return;
    }

    // Load user settings for PIN verification
    const { data: user, error } = await supabase
      .from("user_settings")
      .select("pin_hash, pin_attempts")
      .eq("user_id", userId)
      .single();

    if (error || !user || !user.pin_hash) {
      res.type("text/xml").send(buildTwimlReject("Account configuration error. Goodbye."));
      return;
    }

    // Verify PIN against bcrypt hash
    const pinValid = await bcrypt.compare(digits, user.pin_hash);

    if (!pinValid) {
      return await handlePinFailure(supabase, userId, attempt, res);
    }

    // PIN is correct -- reset attempts
    await supabase
      .from("user_settings")
      .update({ pin_attempts: 0 })
      .eq("user_id", userId);

    // Check usage limits before connecting
    const usageAllowed = await checkUsageLimit(supabase, userId);
    if (!usageAllowed) {
      res.type("text/xml").send(
        buildTwimlReject("You've used all your call time this month. Please upgrade your plan in the dashboard.")
      );
      return;
    }

    // Connect to media stream
    const streamUrl = `${streamBaseUrl}/media-stream?userId=${encodeURIComponent(userId)}`;
    res.type("text/xml").send(buildTwimlConnect(streamUrl));
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Handles a failed PIN attempt: increments counter, locks if over limit.
 * @param supabase - Supabase client
 * @param userId - The user who failed authentication
 * @param attempt - Current attempt number
 * @param res - Express response to send TwiML
 */
async function handlePinFailure(
  supabase: SupabaseClient,
  userId: string,
  attempt: number,
  res: Response
): Promise<void> {
  const newAttempts = attempt;

  if (newAttempts >= MAX_PIN_ATTEMPTS) {
    // Lock the account
    await supabase
      .from("user_settings")
      .update({ pin_locked: true, pin_attempts: newAttempts })
      .eq("user_id", userId);

    console.log(`[twilio] Account locked for user ${userId} after ${newAttempts} failed attempts`);

    res.type("text/xml").send(
      buildTwimlReject(
        "Too many failed attempts. Your account has been locked. Please set a new PIN in your dashboard."
      )
    );
    return;
  }

  // Increment attempts and retry
  await supabase
    .from("user_settings")
    .update({ pin_attempts: newAttempts })
    .eq("user_id", userId);

  res.type("text/xml").send(buildTwimlGatherPin(userId, attempt + 1));
}

/**
 * Checks whether the user has remaining call time for the current month.
 * Sums session durations for the current calendar month and compares
 * against the user's plan limit.
 * @param supabase - Supabase client
 * @param userId - The user to check
 * @returns true if the user can start a new call
 */
async function checkUsageLimit(supabase: SupabaseClient, userId: string): Promise<boolean> {
  // Get the user's plan hours limit
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("hours_limit")
    .eq("user_id", userId)
    .single();

  // Default to free plan (1 hour) if no subscription found
  const hoursLimit = subscription?.hours_limit ?? 1;

  // Sum session durations for the current calendar month
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { data: usage } = await supabase
    .from("sessions")
    .select("duration_seconds")
    .eq("user_id", userId)
    .gte("started_at", periodStart)
    .not("duration_seconds", "is", null);

  const totalSeconds = (usage ?? []).reduce(
    (sum: number, row: { duration_seconds: number }) => sum + (row.duration_seconds ?? 0),
    0
  );

  const hoursUsed = totalSeconds / SECONDS_PER_HOUR;
  return hoursUsed < hoursLimit;
}

/**
 * Builds TwiML XML that prompts the user to enter their PIN via DTMF.
 * @param userId - The user ID to pass in the verify-pin callback URL
 * @param attempt - Current attempt number (for retry tracking)
 * @returns TwiML XML string
 */
export function buildTwimlGatherPin(userId: string, attempt: number): string {
  const message = attempt === 1 ? "Please enter your pin." : "Incorrect pin. Please try again.";
  const actionUrl = `/twilio/verify-pin?userId=${encodeURIComponent(userId)}&attempt=${attempt}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="${PIN_NUM_DIGITS}" action="${actionUrl}" method="POST">
    <Say>${message}</Say>
  </Gather>
  <Say>No input received. Goodbye.</Say>
</Response>`;
}

/**
 * Builds TwiML XML that starts a bidirectional media stream.
 * @param streamUrl - WebSocket URL for the media stream connection
 * @returns TwiML XML string
 */
export function buildTwimlConnect(streamUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connected. How can I help you with your email?</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
}

/**
 * Builds TwiML XML that plays a rejection message and hangs up.
 * @param message - The message to speak before hanging up
 * @returns TwiML XML string
 */
export function buildTwimlReject(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${message}</Say>
</Response>`;
}
