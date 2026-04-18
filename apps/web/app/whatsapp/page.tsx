"use client";

import { useCallback, useEffect, useState } from "react";

type RecipientOption = {
  label: string;
  value: string;
};

type ThreadMessage = {
  id: string;
  contactPhoneNumber: string;
  direction: "inbound" | "outbound";
  text: string;
  metaMessageId: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "received" | "failed";
  errorMessage: string | null;
  createdAt: string;
};

type WhatsAppPageData = {
  config: {
    fromNumber: string | null;
    phoneNumberId: string | null;
    businessAccountId: string | null;
    recipients: RecipientOption[];
  };
  selectedRecipient: string | null;
  messages: ThreadMessage[];
};

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatStatus(status: ThreadMessage["status"]): string {
  return status[0].toUpperCase() + status.slice(1);
}

export default function WhatsAppPage() {
  const [config, setConfig] = useState<WhatsAppPageData["config"] | null>(null);
  const [selectedRecipient, setSelectedRecipient] = useState<string>("");
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadThread = useCallback(async (phoneNumber?: string) => {
    setError(null);

    const query = phoneNumber ? `?phoneNumber=${encodeURIComponent(phoneNumber)}` : "";
    const response = await fetch(`/api/whatsapp/messages${query}`, { cache: "no-store" });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || "Failed to load WhatsApp thread");
    }

    const pageData = data as WhatsAppPageData;
    setConfig(pageData.config);
    setMessages(pageData.messages);
    if (pageData.selectedRecipient) {
      setSelectedRecipient(pageData.selectedRecipient);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function runInitialLoad(): Promise<void> {
      try {
        await loadThread();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load WhatsApp thread");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void runInitialLoad();
    return () => {
      cancelled = true;
    };
  }, [loadThread]);

  useEffect(() => {
    if (!selectedRecipient) return;

    const intervalId = window.setInterval(() => {
      void loadThread(selectedRecipient).catch(() => {});
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [loadThread, selectedRecipient]);

  async function handleRecipientChange(nextRecipient: string): Promise<void> {
    setSelectedRecipient(nextRecipient);
    setIsLoading(true);

    try {
      await loadThread(nextRecipient);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load WhatsApp thread");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSend(): Promise<void> {
    if (!selectedRecipient || !draft.trim()) return;

    setIsSending(true);
    setError(null);

    try {
      const response = await fetch("/api/whatsapp/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phoneNumber: selectedRecipient,
          text: draft,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Failed to send WhatsApp message");
      }

      setDraft("");
      await loadThread(selectedRecipient);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send WhatsApp message");
    } finally {
      setIsSending(false);
    }
  }

  const hasRecipients = Boolean(config?.recipients.length);

  return (
    <>
      <div className="page-header">
        <h1>WhatsApp</h1>
        <p>Send test messages from the business side and watch replies come back through the webhook.</p>
      </div>

      <div className="page-content" style={{ display: "grid", gap: 24 }}>
        <section className="settings-panel" style={{ display: "grid", gap: 16 }}>
          <div>
            <h2 style={{ marginBottom: 8 }}>Account</h2>
            <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              This page sends from the WhatsApp business test number and expects inbound replies through
              `/api/whatsapp/webhook`.
            </p>
          </div>

          <div style={{ display: "grid", gap: 8, fontSize: 14 }}>
            <div><strong>From:</strong> {config?.fromNumber ?? "Not configured"}</div>
            <div><strong>Phone number ID:</strong> {config?.phoneNumberId ?? "Not configured"}</div>
            <div><strong>WhatsApp Business Account ID:</strong> {config?.businessAccountId ?? "Not configured"}</div>
          </div>
        </section>

        <section className="settings-panel" style={{ display: "grid", gap: 16 }}>
          <div>
            <h2 style={{ marginBottom: 8 }}>Thread</h2>
            <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              Pick one recipient, send plain text, then reply from your phone to test the receive path.
            </p>
          </div>

          <label style={{ display: "grid", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
            Recipient
            <select
              value={selectedRecipient}
              onChange={(event) => void handleRecipientChange(event.target.value)}
              disabled={!hasRecipients || isLoading}
              style={{
                background: "var(--bg-main)",
                border: "1px solid var(--border-color)",
                color: "var(--text-primary)",
                padding: "10px 12px",
                fontSize: 14,
                outline: "none",
              }}
            >
              {!hasRecipients && <option value="">Add `WHATSAPP_TEST_RECIPIENTS` in env</option>}
              {config?.recipients.map((recipient) => (
                <option key={recipient.value} value={recipient.value}>
                  {recipient.label}
                </option>
              ))}
            </select>
          </label>

          <div
            style={{
              display: "grid",
              gap: 12,
              padding: 16,
              border: "1px solid var(--text-primary)",
              background: "var(--bg-hover)",
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
                Send test message
              </div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                Type a message here, then press <strong>Send message</strong>.
              </div>
            </div>

            <label style={{ display: "grid", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
              Message
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type a plain-text WhatsApp message..."
              disabled={!selectedRecipient || isSending}
              rows={4}
              style={{
                width: "100%",
                resize: "vertical",
                background: "var(--bg-main)",
                border: "1px solid var(--border-color)",
                color: "var(--text-primary)",
                padding: "12px",
                fontSize: 14,
                outline: "none",
                minHeight: 112,
              }}
            />
            </label>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
              <div style={{ fontSize: 13, color: error ? "#b91c1c" : "var(--text-secondary)" }}>
                {error ?? "Outbound sends go through the API route; inbound replies appear after webhook delivery."}
              </div>

              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!selectedRecipient || isSending}
                style={{
                  padding: "10px 14px",
                  background: "var(--text-primary)",
                  color: "var(--bg-main)",
                  border: "none",
                  cursor: !selectedRecipient || isSending ? "not-allowed" : "pointer",
                  opacity: !selectedRecipient || isSending ? 0.5 : 1,
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {isSending ? "Sending..." : "Send message"}
              </button>
            </div>
          </div>

          <div
            style={{
              border: "1px solid var(--border-color)",
              minHeight: 280,
              maxHeight: 420,
              overflowY: "auto",
              padding: 16,
              display: "grid",
              gap: 12,
              background: "var(--bg-main)",
            }}
          >
            {isLoading ? (
              <div style={{ color: "var(--text-secondary)", fontSize: 14 }}>Loading thread...</div>
            ) : messages.length === 0 ? (
              <div style={{ color: "var(--text-secondary)", fontSize: 14 }}>
                No messages yet. Send one from the business side, then reply from your phone.
              </div>
            ) : (
              messages.map((message) => {
                const isOutbound = message.direction === "outbound";
                return (
                  <div
                    key={message.id}
                    style={{
                      display: "flex",
                      justifyContent: isOutbound ? "flex-end" : "flex-start",
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "78%",
                        padding: "12px 14px",
                        border: "1px solid var(--border-color)",
                        background: isOutbound ? "var(--text-primary)" : "var(--bg-hover)",
                        color: isOutbound ? "var(--bg-main)" : "var(--text-primary)",
                      }}
                    >
                      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5, fontSize: 14 }}>
                        {message.text || " "}
                      </div>
                      <div
                        style={{
                          marginTop: 10,
                          display: "flex",
                          gap: 8,
                          flexWrap: "wrap",
                          fontSize: 11,
                          opacity: 0.8,
                        }}
                      >
                        <span>{formatTimestamp(message.createdAt)}</span>
                        <span>{formatStatus(message.status)}</span>
                        {message.errorMessage && <span>{message.errorMessage}</span>}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>
    </>
  );
}
