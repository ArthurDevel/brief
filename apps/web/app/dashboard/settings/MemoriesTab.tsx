/**
 * Memories tab -- user memory entries that persist across calls.
 */

"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { MemoryEntry } from "@/lib/types";
import {
  buildDashboardErrorFromResponse,
  logAndMapDashboardError,
} from "@/lib/errors/mapDashboardError";
import {
  SETTINGS_FIELD_CARD,
  SETTINGS_FIELD_LABEL,
  SETTINGS_MAX_WIDTH,
  SETTINGS_SECTION_COPY,
  SETTINGS_TEXTAREA,
} from "./settingsUi";

async function fetchMemory(): Promise<MemoryEntry[]> {
  const res = await fetch("/api/memory");
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "MEMORY_LOAD_FAILED",
      error: "Failed to load memory",
    });
  }
  return res.json();
}

async function createMemoryEntry(content: string): Promise<MemoryEntry> {
  const res = await fetch("/api/memory", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "MEMORY_CREATE_FAILED",
      error: "Failed to create memory entry",
    });
  }
  return res.json();
}

async function deleteMemoryEntry(id: string): Promise<void> {
  const res = await fetch("/api/memory", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "MEMORY_DELETE_FAILED",
      error: "Failed to delete memory entry",
    });
  }
}

export default function MemoriesTab() {
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([]);
  const [newMemoryContent, setNewMemoryContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        setMemoryEntries(await fetchMemory());
      } catch (err) {
        setError(logAndMapDashboardError(err, "settings-general", "MEMORY_LOAD_FAILED"));
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  async function handleAddMemoryEntry() {
    if (!newMemoryContent.trim()) {
      return;
    }

    try {
      setError(null);
      const entry = await createMemoryEntry(newMemoryContent.trim());
      setMemoryEntries((prev) => [entry, ...prev]);
      setNewMemoryContent("");
    } catch (err) {
      setError(logAndMapDashboardError(err, "settings-general", "MEMORY_CREATE_FAILED"));
    }
  }

  async function handleDeleteMemoryEntry(id: string) {
    try {
      setError(null);
      await deleteMemoryEntry(id);
      setMemoryEntries((prev) => prev.filter((entry) => entry.id !== id));
      setConfirmingDeleteId((current) => (current === id ? null : current));
    } catch (err) {
      setError(logAndMapDashboardError(err, "settings-general", "MEMORY_DELETE_FAILED"));
    }
  }

  if (loading) {
    return <p className="text-[var(--text-secondary)]">Loading...</p>;
  }

  return (
    <div>
      {error && (
        <div className="mb-6 border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <section className="settings-panel">
        <h2>Memories</h2>
        <p className={SETTINGS_SECTION_COPY}>
          Things the assistant remembers about you across calls.
        </p>

        <div className={`${SETTINGS_MAX_WIDTH} ${SETTINGS_FIELD_CARD} mb-4`}>
          <label className={SETTINGS_FIELD_LABEL}>Add a memory</label>
          <textarea
            value={newMemoryContent}
            onChange={(e) => setNewMemoryContent(e.target.value)}
            placeholder="Add something for the assistant to remember..."
            rows={3}
            className={SETTINGS_TEXTAREA}
          />
          <button
            type="button"
            onClick={handleAddMemoryEntry}
            className="mt-3 border border-zinc-200 px-4 py-3 text-[15px] font-semibold text-black hover:bg-zinc-50"
          >
            Add memory
          </button>
        </div>

        <div className={`${SETTINGS_MAX_WIDTH} space-y-3`}>
          {memoryEntries.map((entry) => (
            <div key={entry.id} className={SETTINGS_FIELD_CARD}>
              <div className="flex items-start gap-3">
                <p className="flex-1 whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--text-secondary)]">
                  {entry.content}
                </p>
                {confirmingDeleteId === entry.id ? (
                  <button
                    type="button"
                    onClick={() => handleDeleteMemoryEntry(entry.id)}
                    className="shrink-0 border border-red-300 bg-red-50 px-3 py-2 text-[13px] font-semibold text-red-700 hover:bg-red-100"
                  >
                    Sure?
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingDeleteId(entry.id)}
                    aria-label="Delete memory"
                    className="shrink-0 p-2 text-zinc-400 hover:text-red-600"
                  >
                    <Trash2 size={18} strokeWidth={1.75} />
                  </button>
                )}
              </div>
            </div>
          ))}
          {memoryEntries.length === 0 && (
            <p className="text-[13px] text-[var(--text-secondary)]">No memory entries yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
