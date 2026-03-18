/**
 * Unit tests for markdown formatting functions.
 *
 * Verifies that formatEmailSummaries, formatEmail, and formatThread
 * produce markdown with the expected structure (headers, metadata fields,
 * separators, snippets). Does not assert exact strings -- just structure.
 */

import { describe, it, expect } from "vitest";
import { formatEmailSummaries, formatEmail, formatThread } from "../markdown-formatter";
import type { EmailSummary, Email, ThreadMessage } from "../types";

// ============================================================================
// TEST DATA
// ============================================================================

const SUMMARY_A: EmailSummary = {
  id: "101",
  from: "Alice <alice@example.com>",
  subject: "Weekly standup notes",
  snippet: "Here are the notes from today's standup meeting.",
  date: "2026-03-10T09:00:00Z",
};

const SUMMARY_B: EmailSummary = {
  id: "102",
  from: "Bob <bob@example.com>",
  subject: "Invoice #1234",
  snippet: "Please find attached the invoice for March.",
  date: "2026-03-11T14:30:00Z",
};

const FULL_EMAIL: Email = {
  id: "101",
  from: "Alice <alice@example.com>",
  to: "you@example.com",
  subject: "Weekly standup notes",
  body: "Here are the notes from today's standup meeting.\n\nWe discussed backend migration.",
  date: "2026-03-10T09:00:00Z",
  isRead: false,
};

const THREAD_MSG_1: ThreadMessage = {
  id: "201",
  from: "Alice <alice@example.com>",
  to: "you@example.com",
  subject: "Project kickoff",
  body: "Let's get started on the project.",
  date: "2026-03-13T10:00:00Z",
};

const THREAD_MSG_2: ThreadMessage = {
  id: "202",
  from: "you@example.com",
  to: "Alice <alice@example.com>",
  subject: "Re: Project kickoff",
  body: "I can start next Monday.",
  date: "2026-03-13T11:30:00Z",
};

// ============================================================================
// TESTS
// ============================================================================

describe("formatEmailSummaries", () => {
  it("includes the title and email count", () => {
    const result = formatEmailSummaries([SUMMARY_A, SUMMARY_B], "Inbox");
    expect(result).toContain("## Inbox (2 emails)");
  });

  it("includes email ids, senders, and dates", () => {
    const result = formatEmailSummaries([SUMMARY_A], "Inbox");
    expect(result).toContain("[id:101]");
    expect(result).toContain("Alice <alice@example.com>");
    expect(result).toContain("2026-03-10T09:00:00Z");
  });

  it("includes subjects and snippets", () => {
    const result = formatEmailSummaries([SUMMARY_A], "Inbox");
    expect(result).toContain("Weekly standup notes");
    expect(result).toContain("> Here are the notes");
  });

  it("handles empty list", () => {
    const result = formatEmailSummaries([], "Search Results");
    expect(result).toContain("## Search Results (0 emails)");
  });

  it("formats multiple emails as separate bullet items", () => {
    const result = formatEmailSummaries([SUMMARY_A, SUMMARY_B], "Inbox");
    expect(result).toContain("[id:101]");
    expect(result).toContain("[id:102]");
    expect(result).toContain("Invoice #1234");
  });
});

describe("formatEmail", () => {
  it("uses subject as h1 heading", () => {
    const result = formatEmail(FULL_EMAIL);
    expect(result).toContain("# Weekly standup notes");
  });

  it("includes all metadata fields", () => {
    const result = formatEmail(FULL_EMAIL);
    expect(result).toContain("**ID:** 101");
    expect(result).toContain("**From:** Alice <alice@example.com>");
    expect(result).toContain("**To:** you@example.com");
    expect(result).toContain("**Date:** 2026-03-10T09:00:00Z");
  });

  it("shows read status", () => {
    const result = formatEmail(FULL_EMAIL);
    expect(result).toContain("**Status:** Unread");

    const readEmail: Email = { ...FULL_EMAIL, isRead: true };
    const readResult = formatEmail(readEmail);
    expect(readResult).toContain("**Status:** Read");
  });

  it("includes a horizontal rule separator before the body", () => {
    const result = formatEmail(FULL_EMAIL);
    expect(result).toContain("---");
  });

  it("includes the full body", () => {
    const result = formatEmail(FULL_EMAIL);
    expect(result).toContain("Here are the notes from today's standup meeting.");
    expect(result).toContain("We discussed backend migration.");
  });
});

describe("formatThread", () => {
  it("includes thread subject and message count in heading", () => {
    const result = formatThread([THREAD_MSG_1, THREAD_MSG_2]);
    expect(result).toContain("# Thread: Project kickoff (2 messages)");
  });

  it("includes from, to, date, and id for each message", () => {
    const result = formatThread([THREAD_MSG_1]);
    expect(result).toContain("**From:** Alice <alice@example.com>");
    expect(result).toContain("**To:** you@example.com");
    expect(result).toContain("**Date:** 2026-03-13T10:00:00Z");
    expect(result).toContain("**ID:** 201");
  });

  it("uses --- separators between messages", () => {
    const result = formatThread([THREAD_MSG_1, THREAD_MSG_2]);
    // Should have separators: before msg1, between msg1 and msg2, after msg2
    const separatorCount = (result.match(/^---$/gm) || []).length;
    expect(separatorCount).toBeGreaterThanOrEqual(3);
  });

  it("includes body text for each message", () => {
    const result = formatThread([THREAD_MSG_1, THREAD_MSG_2]);
    expect(result).toContain("Let's get started on the project.");
    expect(result).toContain("I can start next Monday.");
  });

  it("handles empty thread", () => {
    const result = formatThread([]);
    expect(result).toContain("0 messages");
  });
});
