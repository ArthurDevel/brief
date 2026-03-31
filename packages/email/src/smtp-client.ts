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
import type { SmtpConfig, ReplyContext } from "./types";
import type { UndoRecipe } from "@dublin/tools";
import { resolveSpecialUseFolder } from "./imap-client";

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
 * Sends a reply to an existing email with proper threading headers.
 * Builds In-Reply-To, References, and Re: subject. Not undoable.
 * @param config - SMTP server connection parameters
 * @param context - Reply context from the original email (message ID, recipients, subject)
 * @param body - Reply body text
 * @param replyAll - If true, CC all original To/CC recipients (minus sender)
 * @param senderAddress - The current user's email address (excluded from CC in reply-all)
 * @returns null (not undoable)
 */
export async function replyToEmail(
  config: SmtpConfig,
  context: ReplyContext,
  body: string,
  replyAll: boolean,
  senderAddress: string
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

  // Build subject with Re: prefix only if not already present
  const subject = /^re:/i.test(context.subject)
    ? context.subject
    : `Re: ${context.subject}`;

  // Build References: original references + original message ID
  const references = [...context.references, context.messageId].join(" ");

  // Build CC list for reply-all: original To + CC, minus our own address
  const cc = replyAll
    ? [...context.to, ...context.cc].filter(
        (addr) => addr.toLowerCase() !== senderAddress.toLowerCase()
      )
    : [];

  await transport.sendMail({
    from: senderAddress,
    to: context.from,
    cc: cc.length > 0 ? cc : undefined,
    subject,
    text: body,
    inReplyTo: context.messageId,
    references,
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

  const draftsFolder = await resolveSpecialUseFolder(client, "\\Drafts");
  const result = await client.append(draftsFolder, rawMessage, ["\\Draft", "\\Seen"]);

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
  const draftsFolder = await resolveSpecialUseFolder(client, "\\Drafts");
  const lock = await client.getMailboxLock(draftsFolder);

  try {
    await client.messageFlagsAdd(draftUid, ["\\Deleted"], { uid: true });
    await client.messageDelete(draftUid, { uid: true });
  } finally {
    lock.release();
  }
}

/**
 * Tests an SMTP connection by calling nodemailer's verify().
 * @param config - SMTP server connection parameters
 * @returns Object with ok flag and optional error message
 */
export async function testSmtpConnection(config: SmtpConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: {
        user: config.user,
        pass: config.password,
      },
    });
    await transport.verify();
    transport.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "SMTP connection failed" };
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
