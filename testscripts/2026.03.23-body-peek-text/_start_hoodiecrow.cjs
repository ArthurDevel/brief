/**
 * Starts a Hoodiecrow IMAP server with 5 varied MIME-structure emails for testing.
 *
 * Email types:
 *   1. Plain text (text/plain)
 *   2. HTML-only (text/html)
 *   3. Multipart alternative (text/plain + text/html)
 *   4. Multipart mixed (text/plain + attachment)
 *   5. Nested multipart (multipart/mixed > multipart/alternative > text/plain + text/html)
 *
 * Prints "READY:<port>" to stdout once the server is listening.
 * The Python test script starts this as a subprocess and reads that line.
 */

const path = require("path");
const hoodiecrow = require(
  path.resolve(__dirname, "../../packages/tools/node_modules/hoodiecrow-imap")
);

// ============================================================================
// EMAIL FIXTURES
// ============================================================================

const plainText = {
  raw: `From: alice@example.com\r\nTo: test@localhost\r\nSubject: Plain text email\r\nDate: Mon, 23 Mar 2026 10:00:00 +0000\r\nMessage-Id: <msg-001@example.com>\r\nContent-Type: text/plain\r\n\r\nThis is a plain text body. Nothing fancy here, just regular text content for testing purposes.`,
};

const htmlOnly = {
  raw: `From: bob@example.com\r\nTo: test@localhost\r\nSubject: HTML-only email\r\nDate: Mon, 23 Mar 2026 11:00:00 +0000\r\nMessage-Id: <msg-002@example.com>\r\nContent-Type: text/html\r\n\r\n<html><body><p>This is an <strong>HTML-only</strong> email with no plain text alternative.</p></body></html>`,
};

const multipartAlt = {
  raw: `From: carol@example.com\r\nTo: test@localhost\r\nSubject: Multipart alternative email\r\nDate: Mon, 23 Mar 2026 12:00:00 +0000\r\nMessage-Id: <msg-003@example.com>\r\nContent-Type: multipart/alternative; boundary="alt-boundary-001"\r\n\r\n--alt-boundary-001\r\nContent-Type: text/plain\r\n\r\nThis is the plain text version of the multipart alternative email.\r\n--alt-boundary-001\r\nContent-Type: text/html\r\n\r\n<html><body><p>This is the <em>HTML version</em> of the multipart alternative email.</p></body></html>\r\n--alt-boundary-001--`,
};

const multipartMixed = {
  raw: `From: dave@example.com\r\nTo: test@localhost\r\nSubject: Multipart mixed with attachment\r\nDate: Mon, 23 Mar 2026 13:00:00 +0000\r\nMessage-Id: <msg-004@example.com>\r\nContent-Type: multipart/mixed; boundary="mixed-boundary-001"\r\n\r\n--mixed-boundary-001\r\nContent-Type: text/plain\r\n\r\nThis is the body of the mixed email. It has an attachment below.\r\n--mixed-boundary-001\r\nContent-Type: text/plain; name="notes.txt"\r\nContent-Disposition: attachment; filename="notes.txt"\r\n\r\nThis is the content of the attached file notes.txt.\r\n--mixed-boundary-001--`,
};

const nestedMultipart = {
  raw: `From: eve@example.com\r\nTo: test@localhost\r\nSubject: Nested multipart email\r\nDate: Mon, 23 Mar 2026 14:00:00 +0000\r\nMessage-Id: <msg-005@example.com>\r\nContent-Type: multipart/mixed; boundary="outer-boundary"\r\n\r\n--outer-boundary\r\nContent-Type: multipart/alternative; boundary="inner-boundary"\r\n\r\n--inner-boundary\r\nContent-Type: text/plain\r\n\r\nThis is the plain text inside the nested multipart structure.\r\n--inner-boundary\r\nContent-Type: text/html\r\n\r\n<html><body><p>This is the <strong>HTML</strong> inside the nested multipart structure.</p></body></html>\r\n--inner-boundary--\r\n--outer-boundary\r\nContent-Type: text/plain; name="data.txt"\r\nContent-Disposition: attachment; filename="data.txt"\r\n\r\nAttached file content.\r\n--outer-boundary--`,
};

const messages = [plainText, htmlOnly, multipartAlt, multipartMixed, nestedMultipart];

// ============================================================================
// SERVER SETUP
// ============================================================================

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

const PORT = 14_251;
server.listen(PORT, () => {
  console.log(`READY:${PORT}`);
});
