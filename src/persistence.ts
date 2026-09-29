import { createSeedProject } from "./data";
import type { ComposerDrafts, PendingDraft, PersistedEnvelope, ProjectData } from "./types";

export const STORAGE_KEY = "sologsb-1007-project-v1";
export const PENDING_KEY = "sologsb-1007-pending-v1";
export const DRAFTS_KEY = "sologsb-1007-composer-drafts-v1";
export const SESSION_KEY = "sologsb-1007-session";

export const emptyComposerDrafts = (): ComposerDrafts => ({ text: {}, comment: {}, reply: {} });

export function loadProject(): { project: ProjectData; revision: number } {
  if (typeof localStorage === "undefined") {
    return { project: createSeedProject(), revision: 0 };
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope;
    if (parsed?.schema === 1 && parsed.project?.tracks?.length) {
      return { project: parsed.project, revision: parsed.revision ?? 0 };
    }
  } catch {
    // A malformed local draft falls back to the bundled sample.
  }
  return { project: createSeedProject(), revision: 0 };
}

export function saveProject(
  project: ProjectData,
  revision: number,
  tabId: string,
  options: { kind?: "normal" | "fork"; supersedesRevision?: number; parentId?: string } = {},
): PersistedEnvelope {
  const envelope: PersistedEnvelope = {
    schema: 1,
    id: `${tabId}-${revision}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    parentId: options.parentId,
    revision,
    tabId,
    savedAt: Date.now(),
    kind: options.kind ?? "normal",
    supersedesRevision: options.supersedesRevision,
    project,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  return envelope;
}

export function readEnvelope(): PersistedEnvelope | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope;
  } catch {
    return null;
  }
}

/** Stash edits that were blocked by a fork so they survive a reload. */
export function savePendingDraft(draft: PendingDraft) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(draft));
  } catch {
    // Storage can be unavailable (private mode); the in-memory copy still works.
  }
}

export function loadPendingDraft(): PendingDraft | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingDraft;
    return parsed?.project?.tracks?.length ? parsed : null;
  } catch {
    return null;
  }
}

export function clearPendingDraft() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}

/** Free-text composer state, persisted separately so a reload never loses it. */
export function saveComposerDrafts(drafts: ComposerDrafts) {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // ignore
  }
}

export function loadComposerDrafts(): ComposerDrafts {
  const empty = emptyComposerDrafts();
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<ComposerDrafts>;
    return {
      text: parsed.text ?? {},
      comment: parsed.comment ?? {},
      reply: parsed.reply ?? {},
    };
  } catch {
    return empty;
  }
}

export function downloadText(filename: string, content: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function formatTime(seconds: number, withMillis = true) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const head = [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
  return withMillis ? `${head}.${String(ms).padStart(3, "0")}` : head;
}

export function parseTime(value: string) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(normalized) || 0;
}
