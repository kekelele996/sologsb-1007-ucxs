import { createSeedProject } from "./data";
import type { ProjectData } from "./types";

export const STORAGE_KEY = "sologsb-1007-project-v1";
export const SESSION_KEY = "sologsb-1007-session";
/** Diverged local drafts live in their own keys so the shared copy is never clobbered. */
export const DRAFT_PREFIX = "sologsb-1007-draft-";
/** Last successful save per tab: survives a reload even if it lost a storage race. */
export const OUTBOX_PREFIX = "sologsb-1007-outbox-";
/** A sibling save received while this tab's own save still occupies the head. */
export const INCOMING_PREFIX = "sologsb-1007-incoming-";
export const SCHEMA = 1;

export interface PersistedEnvelope {
  schema: 1;
  /** Monotonic per-tab counter of edits the tab has seen (local or adopted). */
  revision: number;
  /** Author of this envelope. */
  tabId: string;
  /** Unique id of this save; child saves point at it through parentSaveId. */
  saveId: string;
  /** Lineage link to the envelope this save was based on. */
  parentSaveId: string;
  /** Set when a proofreader deliberately overwrote a diverged shared head. */
  forced?: boolean;
  /** For forced saves, the saveId of the head that got replaced. */
  replacedSaveId?: string;
  savedAt: number;
  project: ProjectData;
}

/**
 * A fork that lost the CAS race (or was open when the other tab saved).
 * Kept separately from the shared envelope until the proofreader decides
 * which version wins.
 */
export interface DraftEnvelope {
  kind: "fork-draft";
  tabId: string;
  /** saveId of the shared envelope this fork diverged from. */
  baseSaveId: string;
  parentSaveId: string;
  revision: number;
  savedAt: number;
  project: ProjectData;
}

/** A sibling save observed while this tab's own save was still the head. */
export interface IncomingCandidate {
  kind: "incoming-candidate";
  /** Authoring tab id of the sibling save. */
  fromTabId: string;
  /** saveId of the shared ancestor both sides diverged from. */
  baseSaveId: string;
  envelope: PersistedEnvelope;
}

export type SaveOutcome =
  | { status: "saved"; envelope: PersistedEnvelope }
  | { status: "diverged"; head: PersistedEnvelope; draft: DraftEnvelope };

export type RecoveryMode = "clean" | "fork" | "outbox-winning" | "outbox-losing";

export interface OpenState {
  project: ProjectData;
  revision: number;
  saveId: string;
  parentSaveId: string;
  mode: RecoveryMode;
  /** Present when mode is "fork" or "outbox-losing": the competing head. */
  competitor?: PersistedEnvelope;
  /** Present when mode is "outbox-winning": the parked sibling candidate. */
  candidate?: IncomingCandidate;
}

function randomSaveId() {
  return `sv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isProjectLike(value: unknown): value is ProjectData {
  return typeof value === "object" && value !== null && Array.isArray((value as ProjectData).tracks);
}

function isEnvelope(value: unknown): value is PersistedEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const env = value as Record<string, unknown>;
  return env.schema === SCHEMA && typeof env.revision === "number" && isProjectLike(env.project);
}

function isDraft(value: unknown): value is DraftEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  return draft.kind === "fork-draft" && typeof draft.baseSaveId === "string" && isProjectLike(draft.project);
}

function isCandidate(value: unknown): value is IncomingCandidate {
  if (typeof value !== "object" || value === null) return false;
  const cand = value as Record<string, unknown>;
  return cand.kind === "incoming-candidate" && isEnvelope(cand.envelope);
}

/** Defaults to global localStorage so the module is testable with an injected store. */
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function draftKey(tabId: string) {
  return `${DRAFT_PREFIX}${tabId}`;
}
export function outboxKey(tabId: string) {
  return `${OUTBOX_PREFIX}${tabId}`;
}
export function incomingKey(tabId: string) {
  return `${INCOMING_PREFIX}${tabId}`;
}

function readJson<T>(key: string, guard: (value: unknown) => value is T, store: Store): T | null {
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readEnvelope(store: Store = localStorage): PersistedEnvelope | null {
  const env = readJson(STORAGE_KEY, isEnvelope, store);
  if (env && (!env.saveId || !env.parentSaveId)) {
    // Fill lineage ids on envelopes written by older builds.
    env.saveId = env.saveId || randomSaveId();
    env.parentSaveId = env.parentSaveId || "";
  }
  return env;
}

export function writeEnvelope(envelope: PersistedEnvelope, store: Store = localStorage) {
  store.setItem(STORAGE_KEY, JSON.stringify(envelope));
}

export function readDraft(tabId: string, store: Store = localStorage): DraftEnvelope | null {
  return readJson(draftKey(tabId), isDraft, store);
}

export function writeDraft(draft: DraftEnvelope, store: Store = localStorage) {
  store.setItem(draftKey(draft.tabId), JSON.stringify(draft));
}

export function clearDraft(tabId: string, store: Store = localStorage) {
  store.removeItem(draftKey(tabId));
}

export function readOutbox(tabId: string, store: Store = localStorage): PersistedEnvelope | null {
  return readJson(outboxKey(tabId), isEnvelope, store);
}

export function writeOutbox(envelope: PersistedEnvelope, store: Store = localStorage) {
  store.setItem(outboxKey(envelope.tabId), JSON.stringify(envelope));
}

export function clearOutbox(tabId: string, store: Store = localStorage) {
  store.removeItem(outboxKey(tabId));
}

export function readIncoming(tabId: string, store: Store = localStorage): IncomingCandidate | null {
  return readJson(incomingKey(tabId), isCandidate, store);
}

export function writeIncoming(candidate: IncomingCandidate, tabId: string, store: Store = localStorage) {
  store.setItem(incomingKey(tabId), JSON.stringify(candidate));
}

export function clearIncoming(tabId: string, store: Store = localStorage) {
  store.removeItem(incomingKey(tabId));
}

function seedEnvelope(tabId: string): PersistedEnvelope {
  return {
    schema: SCHEMA,
    revision: 0,
    tabId,
    saveId: randomSaveId(),
    parentSaveId: "",
    savedAt: Date.now(),
    project: createSeedProject(),
  };
}

/** True when `envelope` was produced directly on top of `ancestor` (one hop). */
export function isChild(envelope: PersistedEnvelope, ancestorSaveId: string) {
  return !!ancestorSaveId && envelope.parentSaveId === ancestorSaveId;
}

/** True when two envelopes diverged directly from the same shared ancestor. */
export function isSibling(a: PersistedEnvelope, b: PersistedEnvelope) {
  return !!a.parentSaveId && a.parentSaveId === b.parentSaveId && a.saveId !== b.saveId;
}

/**
 * Opens the local workspace and restores whichever version belongs to this
 * tab, in this priority order:
 * 1. an unresolved fork draft against the current head;
 * 2. the tab's last successful save when it differs from the head (the
 *    proofreader must decide between it and the competing version);
 * 3. an incoming sibling candidate parked for this tab (its own save is
 *    still the head; the other side is awaiting the decision);
 * 4. the shared envelope, or the bundled sample on first ever launch.
 */
export function openProjectState(tabId: string, store: Store = localStorage): OpenState {
  let head = readEnvelope(store);
  if (!head) {
    head = seedEnvelope(tabId);
    writeEnvelope(head, store);
  }
  const draft = readDraft(tabId, store);
  if (draft && draft.baseSaveId === head.saveId) {
    return {
      project: structuredClone(draft.project),
      revision: draft.revision,
      saveId: head.saveId,
      parentSaveId: draft.parentSaveId,
      mode: "fork",
      competitor: head,
    };
  }
  if (draft) clearDraft(tabId, store);

  const outbox = readOutbox(tabId, store);
  if (outbox && outbox.saveId !== head.saveId) {
    // Our last save is not the head. If the head extends it, a later tab
    // built on top of us: stay on the head cleanly.
    if (isChild(head, outbox.saveId)) {
      clearOutbox(tabId, store);
    } else {
      const candidate = readIncoming(tabId, store);
      // Sibling of the head (our save lost a race): keep our content and
      // surface the conflict; either a parked candidate or the head itself
      // is the competing version.
      return {
        project: structuredClone(outbox.project),
        revision: outbox.revision,
        saveId: head.saveId,
        parentSaveId: outbox.parentSaveId,
        mode: "outbox-losing",
        competitor: candidate?.envelope ?? head,
      };
    }
  } else if (outbox && outbox.saveId === head.saveId) {
    const candidate = readIncoming(tabId, store);
    if (
      candidate &&
      candidate.envelope.saveId !== head.saveId &&
      (candidate.baseSaveId === head.saveId || candidate.envelope.parentSaveId === head.parentSaveId)
    ) {
      return {
        project: structuredClone(outbox.project),
        revision: outbox.revision,
        saveId: head.saveId,
        parentSaveId: outbox.saveId,
        mode: "outbox-winning",
        candidate,
      };
    }
    clearIncoming(tabId, store);
    clearOutbox(tabId, store);
  }

  return {
    project: structuredClone(head.project),
    revision: head.revision,
    saveId: head.saveId,
    parentSaveId: head.saveId,
    mode: "clean",
  };
}

/**
 * Compare-and-swap save.
 *
 * `baseSaveId` is the shared envelope the tab last knew about. When the
 * stored head still matches, the write lands. If another tab advanced the
 * head first, the shared copy stays untouched and the local version is
 * parked as a fork draft for the proofreader to resolve.
 */
export function saveProject(
  project: ProjectData,
  revision: number,
  tabId: string,
  baseSaveId: string,
  parentSaveId: string,
  store: Store = localStorage,
): SaveOutcome {
  if (!readEnvelope(store)) {
    writeEnvelope(seedEnvelope(tabId), store);
  }
  const current = readEnvelope(store)!;
  if (current.saveId === baseSaveId) {
    const envelope: PersistedEnvelope = {
      schema: SCHEMA,
      revision,
      tabId,
      saveId: randomSaveId(),
      parentSaveId: parentSaveId || baseSaveId,
      savedAt: Date.now(),
      project,
    };
    writeEnvelope(envelope, store);
    writeOutbox(envelope, store);
    // A new save supersedes any parked conflict state for this tab.
    clearIncoming(tabId, store);
    return { status: "saved", envelope };
  }
  const draft: DraftEnvelope = {
    kind: "fork-draft",
    tabId,
    baseSaveId: current.saveId,
    parentSaveId,
    revision,
    savedAt: Date.now(),
    project,
  };
  writeDraft(draft, store);
  return { status: "diverged", head: current, draft };
}

/**
 * User-conflicted resolution: adopt the other version (fast-forward) or
 * overwrite the shared envelope with the local fork. Any parked drafts are
 * removed afterwards.
 */
export function resolveWithIncoming(
  head: PersistedEnvelope,
  tabId: string,
  store: Store = localStorage,
): PersistedEnvelope {
  writeEnvelope(head, store);
  // We adopt the other version wholesale: abandon our parked draft, the
  // sibling candidate and our own outbox so a later reload cannot mistake
  // them for an unresolved fork.
  clearDraft(tabId, store);
  clearIncoming(tabId, store);
  clearOutbox(tabId, store);
  return head;
}

export function forceSaveLocal(
  project: ProjectData,
  revision: number,
  tabId: string,
  replacedSaveId: string,
  parentSaveId: string,
  store: Store = localStorage,
): PersistedEnvelope {
  const envelope: PersistedEnvelope = {
    schema: SCHEMA,
    revision,
    tabId,
    saveId: randomSaveId(),
    // Honest lineage: keep the fork point, never pretend the replaced head
    // was an ancestor, plus a record of what was overwritten.
    parentSaveId: parentSaveId || replacedSaveId,
    forced: true,
    replacedSaveId,
    savedAt: Date.now(),
    project,
  };
  writeEnvelope(envelope, store);
  writeOutbox(envelope, store);
  clearDraft(tabId, store);
  clearIncoming(tabId, store);
  return envelope;
}

/**
 * Promotes this tab's own save to a forced overwrite of a sibling head
 * (the "keep mine" decision in the later-writer race).
 */
export function promoteOutboxForced(
  ownEnvelope: PersistedEnvelope,
  replacedSaveId: string,
  store: Store = localStorage,
): PersistedEnvelope {
  const forced: PersistedEnvelope = {
    ...structuredClone(ownEnvelope),
    savedAt: Date.now(),
    forced: true,
    replacedSaveId,
  };
  writeEnvelope(forced, store);
  writeOutbox(forced, store);
  clearIncoming(forced.tabId, store);
  return forced;
}

/** Persists the current fork draft without touching the shared envelope. */
export function persistDraft(
  project: ProjectData,
  revision: number,
  tabId: string,
  baseSaveId: string,
  parentSaveId: string,
  store: Store = localStorage,
): DraftEnvelope {
  const draft: DraftEnvelope = {
    kind: "fork-draft",
    tabId,
    baseSaveId,
    parentSaveId,
    revision,
    savedAt: Date.now(),
    project,
  };
  writeDraft(draft, store);
  return draft;
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
