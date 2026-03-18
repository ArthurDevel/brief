/**
 * Tests for snippet extraction from realistic email content.
 *
 * Validates that extractSnippet produces clean, readable text from
 * real-world email formats: multipart MIME, HTML-only, CSS-heavy,
 * quoted-printable, and MIME preamble text.
 *
 * - Uses realistic full RFC822 email constants (headers + body)
 * - Replicates the extractSnippet pipeline (simpleParser + TurnDown + truncate)
 * - Asserts output contains no HTML, CSS, MIME boundaries, or MIME headers
 */

import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import TurndownService from "turndown";

// ============================================================================
// CONSTANTS - REALISTIC EMAIL SAMPLES
// ============================================================================

const SNIPPET_LENGTH = 100;

/**
 * Multipart MIME email with text/plain + text/html parts.
 */
const MULTIPART_MIME_EMAIL = [
  "From: sender@example.com",
  "To: recipient@example.com",
  "Subject: Meeting notes",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="_boundary123"',
  "",
  "--_boundary123",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: 7bit",
  "",
  "Hey, here are the meeting notes from today.",
  "--_boundary123",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Hey, here are the meeting notes from today.</p></body></html>",
  "--_boundary123--",
].join("\r\n");

/**
 * HTML email with <style> block containing CSS rules.
 * Based on real Chase email that leaked CSS into snippet.
 */
const HTML_WITH_CSS_EMAIL = [
  "From: alerts@chase.com",
  "To: user@example.com",
  "Subject: You updated your digital wallet",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<!DOCTYPE html><html><head><style type="text/css">* { line-height: normal !important; } strong { font-weight: bold !important; } em { font-style: italic !important; }</style></head><body><p>You updated your digital wallet successfully.</p></body></html>',
].join("\r\n");

/**
 * Multipart email with MIME preamble text.
 * Based on real Chase email that showed MIME preamble in snippet.
 */
const MIME_PREAMBLE_EMAIL = [
  "From: scheduler@chase.com",
  "To: user@example.com",
  "Subject: We've scheduled your meeting!",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="y4nfrcCGDZOk"',
  "",
  "This is a multi-part message in MIME format.",
  "--y4nfrcCGDZOk",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "We've scheduled your meeting for March 20th at 2pm.",
  "--y4nfrcCGDZOk",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>We&#39;ve scheduled your meeting for March 20th at 2pm.</p></body></html>",
  "--y4nfrcCGDZOk--",
].join("\r\n");

/**
 * Multipart email with inline charset= fragments leaking through.
 * Based on real Twilio email.
 */
const INLINE_CHARSET_EMAIL = [
  "From: support@twilio.zendesk.com",
  "To: user@example.com",
  "Subject: [ACTION REQUIRED] Your Trust Hub Business Profile",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="mimepart_abc123"',
  "",
  "--mimepart_abc123",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "## In replies all text above this line is added to the ticket ##",
  "",
  "Camille, Mar 17, 2026: Your business profile needs verification.",
  "--mimepart_abc123--",
].join("\r\n");

/**
 * HTML with quoted-printable encoding (=3D for equals, =2C for comma).
 * Based on real realtor.com email.
 */
const QUOTED_PRINTABLE_HTML_EMAIL = [
  "From: realtor@example.com",
  "To: user@example.com",
  "Subject: 10 new listings in San Francisco, CA",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  '<!DOCTYPE html><html><head><style type=3D"text/css"> /* reset */ * {margin-top:0px;margin-bottom:0px}</style></head><body><p>10 new listings in San Francisco=2C CA matching your criteria.</p></body></html>',
].join("\r\n");

/** Simple plain text email -- baseline. */
const CLEAN_PLAIN_TEXT_EMAIL = [
  "From: john@example.com",
  "To: user@example.com",
  "Subject: Follow up",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hey John, just wanted to follow up on our conversation yesterday. Let me know when you are free to chat.",
].join("\r\n");

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Replicates the extractSnippet pipeline from imap-client.ts.
 * Uses simpleParser + TurnDown (same as extractBodyFromMime), then truncates.
 * @param source - Full RFC822 email source
 * @returns Cleaned snippet string
 */
async function extractSnippetFromSource(source: string): Promise<string> {
  const parsed = await simpleParser(source);

  let body = "";
  if (parsed.text) {
    body = parsed.text.trim();
  } else if (parsed.html) {
    const turndown = new TurndownService();
    turndown.addRule("removeImages", { filter: "img", replacement: () => "" });
    turndown.addRule("removeEmptyLinks", {
      filter: (node: HTMLElement) => node.nodeName === "A" && !node.textContent?.trim(),
      replacement: () => "",
    });
    body = turndown.turndown(parsed.html).trim();
  }

  if (!body) return "";

  // Same cleanup as extractBodyFromMime
  body = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  body = body.replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, "");
  body = body.replace(/ {2,}/g, " ");

  return body.substring(0, SNIPPET_LENGTH).replace(/\s+/g, " ").trim();
}

// ============================================================================
// TESTS
// ============================================================================

describe("Snippet extraction from realistic email content", () => {
  it("strips MIME boundaries and headers from multipart emails", async () => {
    const snippet = await extractSnippetFromSource(MULTIPART_MIME_EMAIL);

    expect(snippet).not.toContain("--_");
    expect(snippet).not.toContain("Content-Type:");
    expect(snippet).not.toContain("Content-Transfer-Encoding:");
    expect(snippet).not.toContain("<");
    expect(snippet).not.toContain(">");
    expect(snippet).toContain("meeting notes");
  });

  it("strips CSS content from HTML emails with <style> blocks", async () => {
    const snippet = await extractSnippetFromSource(HTML_WITH_CSS_EMAIL);

    expect(snippet).not.toContain("line-height");
    expect(snippet).not.toContain("!important");
    expect(snippet).not.toContain("font-weight");
    expect(snippet).not.toContain("{");
    expect(snippet).not.toContain("}");
    expect(snippet).not.toContain("<");
    expect(snippet).not.toContain(">");
    expect(snippet).toContain("digital wallet");
  });

  it("strips MIME preamble text from multipart emails", async () => {
    const snippet = await extractSnippetFromSource(MIME_PREAMBLE_EMAIL);

    expect(snippet).not.toContain("multi-part message in MIME format");
    expect(snippet).not.toContain("Content-Type:");
    expect(snippet).not.toContain("<");
    expect(snippet).toContain("scheduled");
  });

  it("strips inline charset fragments from partial MIME content", async () => {
    const snippet = await extractSnippetFromSource(INLINE_CHARSET_EMAIL);

    expect(snippet).not.toContain("charset=");
    expect(snippet).not.toContain("mimepart");
    expect(snippet).not.toContain("Content-Type:");
    // "business profile" is beyond the 100-char snippet limit, but the text is clean
    expect(snippet).toContain("In replies all text above this line");
  });

  it("strips quoted-printable HTML including =3D encoded style attributes", async () => {
    const snippet = await extractSnippetFromSource(QUOTED_PRINTABLE_HTML_EMAIL);

    expect(snippet).not.toContain("<!DOCTYPE");
    expect(snippet).not.toContain("<html");
    expect(snippet).not.toContain("<");
    expect(snippet).not.toContain("margin-top");
    expect(snippet).not.toContain("{");
    expect(snippet).not.toContain("=3D");
    expect(snippet).toContain("listings");
  });

  it("handles clean plain text correctly (baseline)", async () => {
    const snippet = await extractSnippetFromSource(CLEAN_PLAIN_TEXT_EMAIL);

    expect(snippet).not.toContain("<");
    expect(snippet).not.toContain(">");
    expect(snippet).not.toContain("--_");
    expect(snippet).not.toContain("Content-Type:");
    expect(snippet).toContain("follow up");
  });

  it("strips zero-width characters from snippets", async () => {
    const emailWithZwc = [
      "From: no-reply@dribbble.com",
      "Subject: Protein branding",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Plus: redundancy reframed \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c",
    ].join("\r\n");

    const snippet = await extractSnippetFromSource(emailWithZwc);

    // Should not contain zero-width non-joiner characters
    expect(snippet).not.toContain("\u200c");
    // Should contain readable text
    expect(snippet).toContain("redundancy reframed");
  });
});
