/**
 * Admin dashboard for transactional (engagement) emails.
 *
 * Shows summary stats, filterable table of all sent emails,
 * and per-user drill-down via email search.
 *
 * Responsibilities:
 * - Display summary stats (total, sent today, per-type breakdown)
 * - Display paginated table of email events with filters
 * - Allow filtering by user email (partial match) and email type
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import {
  EMAIL_TYPE_OPTIONS,
  getEmailPathLabel,
  getEmailTypeLabel,
} from "@/lib/engagement/catalog";
import {
  fetchEmailEvents,
  fetchEmailStats,
  type EmailEventItem,
  type EmailStats,
} from "./actions";

// ============================================================================
// CONSTANTS
// ============================================================================

const PAGE_SIZE = 50;

const EMAIL_TYPES = [
  { value: "", label: "All types" },
  ...EMAIL_TYPE_OPTIONS,
] as const;

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

// ============================================================================
// RENDER
// ============================================================================

export default function TransactionalEmailsPage() {
  const [events, setEvents] = useState<EmailEventItem[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [stats, setStats] = useState<EmailStats | null>(null);
  const [searchEmail, setSearchEmail] = useState<string>("");
  const [emailType, setEmailType] = useState<string>("");
  const [page, setPage] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Debounced search value
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");

  // Debounce the search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchEmail);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchEmail]);

  // Reset page when email type filter changes
  useEffect(() => {
    setPage(0);
  }, [emailType]);

  // Load stats once
  useEffect(() => {
    fetchEmailStats()
      .then(setStats)
      .catch((err) => console.error("Failed to fetch stats:", err));
  }, []);

  // Load events when filters or page change
  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchEmailEvents({
        searchEmail: debouncedSearch || undefined,
        emailType: emailType || undefined,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      setEvents(result.events);
      setTotalCount(result.totalCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, emailType, page]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <>
      <div className="page-header">
        <h1>Transactional Emails</h1>
        <p>Overview of all engagement emails sent to users</p>
      </div>

      <div className="page-content">
        {/* Stats row */}
        {stats && (
          <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
            <StatCard label="Total sent" value={stats.total} />
            <StatCard label="Last 24h" value={stats.sentToday} />
            {Object.entries(stats.byType)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([type, count]) => (
                <StatCard key={type} label={getEmailTypeLabel(type)} value={count} small />
              ))}
          </div>
        )}

        {/* Filters */}
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Search by user email..."
            value={searchEmail}
            onChange={(e) => setSearchEmail(e.target.value)}
            style={{
              background: "var(--bg-main)",
              border: "1px solid var(--border-color)",
              color: "var(--text-primary)",
              padding: "8px 12px",
              fontSize: 13,
              borderRadius: 0,
              outline: "none",
              width: 280,
              maxWidth: "100%",
            }}
          />
          <select
            value={emailType}
            onChange={(e) => setEmailType(e.target.value)}
            style={{
              background: "var(--bg-main)",
              border: "1px solid var(--border-color)",
              color: "var(--text-primary)",
              padding: "8px 12px",
              fontSize: 13,
              borderRadius: 0,
              outline: "none",
            }}
          >
            {EMAIL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {totalCount} result{totalCount !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Error state */}
        {error && (
          <div style={{ padding: 16, color: "#ef4444", fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {/* Table */}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
                <Th>User</Th>
                <Th>Path</Th>
                <Th>Email Type</Th>
                <Th>Resend ID</Th>
                <Th>Sent At</Th>
              </tr>
            </thead>
            <tbody>
              {loading && events.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>
                    Loading...
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>
                    No email events found
                  </td>
                </tr>
              ) : (
                events.map((event) => (
                  <tr key={event.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                    <Td>
                      <span title={event.userId} style={{ cursor: "default" }}>
                        {event.userEmail}
                      </span>
                    </Td>
                    <Td>
                      <span style={{
                        display: "inline-block",
                        padding: "2px 6px",
                        fontSize: 11,
                        fontWeight: 600,
                        background: "var(--bg-hover)",
                        color: "var(--text-secondary)",
                      }}>
                        {getEmailPathLabel(event.emailType)}
                      </span>
                    </Td>
                    <Td>{getEmailTypeLabel(event.emailType)}</Td>
                    <Td>
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-secondary)" }}>
                        {event.resendEmailId || "--"}
                      </span>
                    </Td>
                    <Td>
                      {new Date(event.sentAt).toLocaleDateString("en-US", DATE_FORMAT)}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center", justifyContent: "center" }}>
            <PaginationButton
              label="Previous"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            />
            <span style={{ fontSize: 12, color: "var(--text-secondary)", padding: "0 8px" }}>
              Page {page + 1} of {totalPages}
            </span>
            <PaginationButton
              label="Next"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            />
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================================
// COMPONENTS
// ============================================================================

function StatCard({ label, value, small }: { label: string; value: number; small?: boolean }) {
  return (
    <div style={{
      background: "var(--bg-surface)",
      border: "1px solid var(--border-color)",
      padding: small ? "12px 16px" : "16px 20px",
      minWidth: small ? 120 : 140,
    }}>
      <div style={{ fontSize: small ? 18 : 24, fontWeight: 600, color: "var(--text-primary)" }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{
      textAlign: "left",
      padding: "10px 12px",
      fontSize: 11,
      fontWeight: 600,
      color: "var(--text-secondary)",
      textTransform: "uppercase",
      letterSpacing: "0.5px",
    }}>
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td style={{ padding: "10px 12px", color: "var(--text-primary)" }}>
      {children}
    </td>
  );
}

function PaginationButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        background: "var(--btn-secondary-bg)",
        border: "1px solid var(--btn-secondary-border)",
        color: disabled ? "var(--text-secondary)" : "var(--btn-secondary-text)",
        padding: "6px 14px",
        fontSize: 12,
        fontWeight: 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        borderRadius: 0,
      }}
    >
      {label}
    </button>
  );
}
