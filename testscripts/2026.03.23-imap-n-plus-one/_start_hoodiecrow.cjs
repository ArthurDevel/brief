/**
 * Starts a Hoodiecrow IMAP server with 20 seed emails for testing.
 *
 * Prints "READY:<port>" to stdout once the server is listening.
 * The Python test script starts this as a subprocess and reads that line.
 */

const path = require("path");
const hoodiecrow = require(path.resolve(__dirname, "../../packages/tools/node_modules/hoodiecrow-imap"));

const messages = [];
for (let i = 1; i <= 20; i++) {
  messages.push({
    raw: [
      `From: sender${i}@example.com`,
      `To: testuser@localhost`,
      `Subject: Test email ${i}`,
      `Date: ${new Date(2026, 2, i).toUTCString()}`,
      `Message-Id: <msg-${String(i).padStart(3, "0")}@example.com>`,
      `Content-Type: text/plain`,
      ``,
      `Body of test email ${i}.`,
    ].join("\r\n"),
  });
}

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
    "SPECIAL-USE",
    "CREATE-SPECIAL-USE",
  ],
  storage: {
    INBOX: { messages },
    "": {
      separator: "/",
      folders: {
        "[Google Mail]": {
          flags: ["\\Noselect"],
          folders: {
            "All Mail": { "special-use": "\\All", messages: [...messages] },
            Drafts: { "special-use": "\\Drafts" },
            "Sent Mail": { "special-use": "\\Sent" },
            Trash: { "special-use": "\\Trash" },
          },
        },
      },
    },
  },
});

const PORT = 14_250;
server.listen(PORT, () => {
  console.log(`READY:${PORT}`);
});
