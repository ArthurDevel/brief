/**
 * Standalone Hoodiecrow IMAP server for Python integration tests.
 *
 * Spawned as a subprocess by conftest.py. Prints "READY" to stdout
 * once listening, then stays alive until killed.
 *
 * Uses the same seed data and folder layout as the TypeScript tests.
 */

const path = require("path");
const hoodiecrow = require(path.resolve(__dirname, "../../..", "packages/email/node_modules/hoodiecrow-imap"));

const PORT = 14143;

const SEED_MESSAGES = [
  {
    raw: [
      "From: Alice <alice@example.com>",
      "To: testuser@localhost",
      "Subject: Weekly standup notes",
      "Date: Mon, 10 Mar 2026 09:00:00 +0000",
      "Message-Id: <msg-001@example.com>",
      "",
      "Here are the notes from today's standup meeting.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Bob <bob@example.com>",
      "To: testuser@localhost",
      "Subject: Invoice #1234",
      "Date: Tue, 11 Mar 2026 14:30:00 +0000",
      "Message-Id: <msg-002@example.com>",
      "",
      "Please find attached the invoice for March.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Carol <carol@example.com>",
      "To: testuser@localhost",
      "Subject: Lunch tomorrow?",
      "Date: Wed, 12 Mar 2026 11:00:00 +0000",
      "Message-Id: <msg-003@example.com>",
      "",
      "Hey, want to grab lunch tomorrow at noon?",
    ].join("\r\n"),
  },
  // HTML email with <style> block and CSS rules (based on real Chase email)
  {
    raw: [
      "From: Chase <no.reply.alerts@chase.com>",
      "To: testuser@localhost",
      "Subject: You updated your digital wallet",
      "Date: Thu, 13 Mar 2026 08:00:00 +0000",
      "Message-Id: <msg-html-css@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<!DOCTYPE html><html><head><style type="text/css">* { line-height: normal !important; } strong { font-weight: bold !important; } em { font-style: italic !important; }</style></head><body><p>You updated your digital wallet successfully.</p></body></html>',
    ].join("\r\n"),
  },
  // HTML email with heavy table layout (based on real Proximus email)
  {
    raw: [
      "From: Proximus <service@proximus.com>",
      "To: testuser@localhost",
      "Subject: Bevestiging van wijziging",
      "Date: Thu, 13 Mar 2026 08:30:00 +0000",
      "Message-Id: <msg-html-table@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<html><body><table><tr><td></td><td></td><td></td></tr><tr><td></td><td></td><td></td></tr></table><p>Jouw wijziging is bevestigd. Je nieuwe abonnement gaat in op 1 april.</p></body></html>',
    ].join("\r\n"),
  },
  // HTML email with image links (based on real Stage Freaks email)
  {
    raw: [
      "From: Stage Freaks <info@stagefreaks.nl>",
      "To: testuser@localhost",
      "Subject: Laatste rigging cursus",
      "Date: Thu, 13 Mar 2026 09:00:00 +0000",
      "Message-Id: <msg-html-img@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<html><body><a href="https://example.com/course"><img src="https://example.com/banner.jpg"></a><p>Hoi Arthur, wil jij je rigging skills verbeteren?</p></body></html>',
    ].join("\r\n"),
  },
  // Plain text email with zero-width characters (based on real Dribbble email)
  {
    raw: [
      "From: Dribbble <no-reply@dribbble.com>",
      "To: testuser@localhost",
      "Subject: Protein branding",
      "Date: Thu, 13 Mar 2026 09:30:00 +0000",
      "Message-Id: <msg-zwc@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Plus: redundancy reframed \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c \u200c and the truth behind calm tech.",
    ].join("\r\n"),
  },
  // Multipart email with text/plain + text/html (common format)
  {
    raw: [
      "From: npm <support@npmjs.com>",
      "To: testuser@localhost",
      "Subject: Successfully published voicecc@1.2.10",
      "Date: Thu, 13 Mar 2026 10:00:00 +0000",
      "Message-Id: <msg-multipart@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="npm-boundary"',
      "",
      "--npm-boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hi arthurdevel! A new version of the package voicecc (1.2.10) was published.",
      "--npm-boundary",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><p>Hi arthurdevel! A new version of the package <strong>voicecc</strong> (1.2.10) was published.</p></body></html>",
      "--npm-boundary--",
    ].join("\r\n"),
  },
];

const THREAD_MSG_1 = {
  raw: [
    "From: Alice <alice@example.com>",
    "To: testuser@localhost",
    "Subject: Project kickoff",
    "Date: Thu, 13 Mar 2026 10:00:00 +0000",
    "Message-Id: <thread-001@example.com>",
    "",
    "Let's get started on the project. When can you begin?",
  ].join("\r\n"),
};

const THREAD_MSG_2 = {
  raw: [
    "From: testuser@localhost",
    "To: Alice <alice@example.com>",
    "Subject: Re: Project kickoff",
    "Date: Thu, 13 Mar 2026 11:30:00 +0000",
    "Message-Id: <thread-002@example.com>",
    "In-Reply-To: <thread-001@example.com>",
    "References: <thread-001@example.com>",
    "",
    "I can start next Monday. Does that work?",
  ].join("\r\n"),
};

const THREAD_MSG_3 = {
  raw: [
    "From: Alice <alice@example.com>",
    "To: testuser@localhost",
    "Subject: Re: Project kickoff",
    "Date: Thu, 13 Mar 2026 14:00:00 +0000",
    "Message-Id: <thread-003@example.com>",
    "In-Reply-To: <thread-002@example.com>",
    "References: <thread-001@example.com> <thread-002@example.com>",
    "",
    "Monday works! See you then.",
  ].join("\r\n"),
};

const server = hoodiecrow({
  plugins: [
    "ID",
    "SASL-IR",
    "AUTH-PLAIN",
    "NAMESPACE",
    "IDLE",
    "ENABLE",
    "CONDSTORE",
    "LITERALPLUS",
    "UNSELECT",
    "MOVE",
    "UIDPLUS",
    "SPECIAL-USE",
    "CREATE-SPECIAL-USE",
  ],
  storage: {
    INBOX: {
      messages: [...SEED_MESSAGES, THREAD_MSG_1, THREAD_MSG_3],
    },
    "": {
      separator: "/",
      folders: {
        "[Gmail]": {
          flags: ["\\Noselect"],
          folders: {
            "All Mail": {
              "special-use": "\\All",
              messages: [
                ...SEED_MESSAGES,
                THREAD_MSG_1,
                THREAD_MSG_2,
                THREAD_MSG_3,
              ],
            },
            Drafts: { "special-use": "\\Drafts" },
            "Sent Mail": {
              "special-use": "\\Sent",
              messages: [THREAD_MSG_2],
            },
            Trash: { "special-use": "\\Trash" },
          },
        },
      },
    },
  },
});

server.listen(PORT, () => {
  console.log("READY");
});
