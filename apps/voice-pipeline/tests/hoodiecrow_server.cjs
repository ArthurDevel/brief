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
