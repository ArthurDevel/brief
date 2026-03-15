/**
 * SMTP client operations for sending emails and managing drafts.
 *
 * Uses nodemailer for SMTP transport and ImapFlow for draft management
 * (drafts are stored via IMAP APPEND to the Drafts folder).
 *
 * Responsibilities:
 * - Send emails via SMTP
 * - Save drafts via IMAP APPEND
 * - Delete drafts by UID (used by undo)
 */

import type { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { SmtpConfig } from "./types";
import type { UndoRecipe } from "@dublin/tools";

// ============================================================================
// CONSTANTS
// ============================================================================

const DRAFTS_FOLDER = "[Gmail]/Drafts";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Sends an email via nodemailer SMTP transport.
 * Not undoable -- returns null.
 * @param config - SMTP server connection parameters
 * @param params - Email parameters (to, subject, body)
 * @returns null (not undoable)
 */
export async function sendEmail(
  config: SmtpConfig,
  params: { to: string; subject: string; body: string }
): Promise<null> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.password,
    },
  });

  await transport.sendMail({
    from: config.user,
    to: params.to,
    subject: params.subject,
    text: params.body,
  });

  return null;
}

/**
 * Saves an email draft by appending to the Drafts folder via IMAP.
 * @param client - Connected ImapFlow client
 * @param params - Draft parameters (to, subject, body)
 * @returns UndoRecipe to delete the created draft
 */
export async function saveDraft(
  client: ImapFlow,
  params: { to: string; subject: string; body: string }
): Promise<UndoRecipe> {
  const rawMessage = buildRawMessage(params);

  const result = await client.append(DRAFTS_FOLDER, rawMessage, ["\\Draft", "\\Seen"]);

  if (!result) {
    throw new Error("Failed to append draft -- no response from server");
  }

  const draftUid = String(result.uid ?? result.uidValidity ?? "unknown");

  return {
    operation: "delete_draft",
    params: { draftUid },
  };
}

/**
 * Deletes a draft by UID. Used by undo after draft_email.
 * @param client - Connected ImapFlow client
 * @param draftUid - The UID of the draft to delete
 */
export async function deleteDraft(client: ImapFlow, draftUid: string): Promise<void> {
  const lock = await client.getMailboxLock(DRAFTS_FOLDER);

  try {
    await client.messageFlagsAdd(draftUid, ["\\Deleted"], { uid: true });
    await client.messageDelete(draftUid, { uid: true });
  } finally {
    lock.release();
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds a raw RFC 2822 email message from parameters.
 * @param params - Email parameters (to, subject, body)
 * @returns Raw email string suitable for IMAP APPEND
 */
function buildRawMessage(params: { to: string; subject: string; body: string }): string {
  const date = new Date().toUTCString();

  return [
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    `Date: ${date}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    params.body,
  ].join("\r\n");
}
