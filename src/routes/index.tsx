import { Checkbox } from "@kobalte/core/checkbox";
import { Dialog } from "@kobalte/core/dialog";
import { Tabs } from "@kobalte/core/tabs";
import {
  For,
  Show,
  batch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { uid } from "../data";
import {
  SESSION_KEY,
  downloadText,
  forceSaveLocal,
  formatTime,
  isChild,
  isSibling,
  openProjectState,
  parseTime,
  persistDraft,
  promoteOutboxForced,
  readEnvelope,
  readOutbox,
  resolveWithIncoming,
  saveProject,
  writeIncoming,
  type IncomingCandidate,
  type PersistedEnvelope,
} from "../persistence";
import type { Confidence, ProjectData, Segment, TranscriptTrack } from "../types";

const CHANNEL_NAME = "sologsb-1007-editor";
// A stable per-tab identity: sessionStorage is partitioned per tab, survives
// reloads (so parked fork drafts/outboxes can be reattached) and clears when
// the tab closes. A fresh random id per load would orphan those keys.
function resolveTabId() {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const created = uid("tab");
    sessionStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return uid("tab");
  }
}
const TAB_ID = resolveTabId();

/**
 * syncing  - local view is allowed to CAS into the shared envelope;
 * forked   - the shared head moved first; local edits are parked as drafts,
 *            proofreader must choose which version survives;
 * awaiting - our save is the head and another tab saved a sibling first;
 *            the other side is waiting for this tab's decision, so our
 *            edits stay local and must not overwrite anything.
 */
type SyncPhase = "syncing" | "forked" | "awaiting";

interface ConflictState {
  /** Competing envelope to choose against. */
  competitor: PersistedEnvelope;
}

function statusText(status: "saved" | "saving" | "offline") {
  if (status === "saving") return "正在保存";
  if (status === "offline") return "离线草稿";
  return "已自动保存";
}

function parseTimedTranscript(input: string, trackName: string): TranscriptTrack {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start: parseTime(match?.[1] ?? "0"),
        end: parseTime(match?.[2] ?? "1"),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start,
        end: start + Math.max(3, text.length / 5),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push({
        id: uid("seg"),
        start: index * 6,
        end: index * 6 + 5.4,
        speakerId: "sp-interviewer",
        text,
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
    });
  }

  return {
    id: uid("track"),
    name: trackName || "导入轨",
    language: "待识别",
    status: "待校对",
    segments,
  };
}

export default function OralHistoryEditor() {
  const opened = openProjectState(TAB_ID);
  const startsConflicted = opened.mode === "fork" || opened.mode === "outbox-losing" || opened.mode === "outbox-winning";
  const [project, setProject] = createSignal<ProjectData>(opened.project);
  const [revision, setRevision] = createSignal(opened.revision);
  // saveId of the shared envelope this tab's view is based on.
  const [baseSaveId, setBaseSaveId] = createSignal(opened.saveId);
  // saveId of the last save this tab produced/adopted.
  const [parentSaveId, setParentSaveId] = createSignal(opened.parentSaveId);
  const [phase, setPhase] = createSignal<SyncPhase>(startsConflicted ? "forked" : "syncing");
  const [past, setPast] = createSignal<ProjectData[]>([]);
  const [future, setFuture] = createSignal<ProjectData[]>([]);
  const [selectedId, setSelectedId] = createSignal(opened.project.tracks[0]?.segments[0]?.id ?? "");
  const [saveStatus, setSaveStatus] = createSignal<"saved" | "saving" | "offline">(startsConflicted ? "offline" : "saved");
  const startupNotice =
    opened.mode === "fork"
      ? "已恢复上次未同步的分叉草稿，请确认保留哪份"
      : opened.mode === "outbox-losing"
        ? "本页的保存与另一标签页发生分叉，请选择保留哪份"
        : opened.mode === "outbox-winning"
          ? "另一个标签页基于本页版本分叉，等待您选择保留哪份"
          : "示例项目已就绪";
  const [lastAction, setLastAction] = createSignal(startupNotice);
  const [conflict, setConflict] = createSignal<ConflictState | null>(
    opened.competitor ? { competitor: opened.competitor } : opened.candidate ? { competitor: opened.candidate.envelope } : null,
  );
  const [online, setOnline] = createSignal(true);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [commentDraft, setCommentDraft] = createSignal("");
  const [replyDrafts, setReplyDrafts] = createSignal<Record<string, string>>({});
  const [trackFilter, setTrackFilter] = createSignal<"all" | "unreviewed" | "low">("all");
  let editorRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  // Set only by edits made in THIS tab; adoption of another tab's save clears it.
  let localDirty = startsConflicted;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
  const activeTrack = createMemo(() => {
    const data = project();
    return data.tracks.find((track) => track.id === data.activeTrackId) ?? data.tracks[0];
  });
  const activeSegment = createMemo(() => activeTrack()?.segments.find((item) => item.id === selectedId()) ?? null);
  const visibleSegments = createMemo(() => {
    const segments = activeTrack()?.segments ?? [];
    if (trackFilter() === "unreviewed") return segments.filter((segment) => !segment.reviewed);
    if (trackFilter() === "low") return segments.filter((segment) => segment.confidence <= 2 || segment.flags.lowConfidence);
    return segments;
  });
  const completedPercent = createMemo(() => {
    const segments = project().tracks.flatMap((track) => track.segments);
    if (!segments.length) return 0;
    return Math.round((segments.filter((segment) => segment.reviewed).length / segments.length) * 100);
  });
  const speakerById = (speakerId: string) =>
    project().speakers.find((speaker) => speaker.id === speakerId) ?? project().speakers[0];
  const tagById = (tagId: string) => project().tags.find((tag) => tag.id === tagId);

  /**
   * Write-through persistence. Every edit lands in localStorage synchronously,
   * so refreshes, tab closes and sudden network loss cannot drop the last
   * keystrokes. A lost CAS (or an unresolved cross-tab fork) parks the local
   * version in its own draft key instead of overwriting the other save.
   */
  const syncSave = (): void => {
    setSaveStatus("saving");
    // While waiting for the other tab's proofreader to decide, the shared
    // copy is frozen for us: refresh only the parked fork draft.
    if (phase() === "awaiting") {
      persistDraft(project(), revision(), TAB_ID, baseSaveId(), parentSaveId());
      localDirty = true;
      setSaveStatus("offline");
      return;
    }
    const outcome = saveProject(project(), revision(), TAB_ID, baseSaveId(), parentSaveId());
    if (outcome.status === "saved") {
      setBaseSaveId(outcome.envelope.saveId);
      setParentSaveId(outcome.envelope.saveId);
      localDirty = false;
      setPhase("syncing");
      setConflict(null);
      setSaveStatus(online() ? "saved" : "offline");
      channel?.postMessage({ type: "sologsb-save", envelope: outcome.envelope });
      return;
    }
    // Shared head moved first: keep it intact, keep editing locally, and ask.
    setBaseSaveId(outcome.head.saveId);
    localDirty = true;
    setPhase("forked");
    setSaveStatus("offline");
    setConflict({ competitor: outcome.head });
  };

  const commit = (label: string, mutate: (draft: ProjectData) => void) => {
    const current = structuredClone(project());
    const next = structuredClone(current);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    batch(() => {
      setPast((items) => [...items.slice(-49), current]);
      setFuture([]);
      setProject(next);
      setRevision((value) => value + 1);
      setLastAction(label);
    });
    localDirty = true;
    syncSave();
  };

  const commitSegment = (label: string, mutate: (segment: Segment, draft: ProjectData) => void) => {
    const id = selectedId();
    commit(label, (draft) => {
      const track = draft.tracks.find((item) => item.id === draft.activeTrackId);
      const segment = track?.segments.find((item) => item.id === id);
      if (segment) mutate(segment, draft);
    });
  };

  // Coalesce rapid keystrokes in one text field into a single undo entry,
  // while still persisting every keystroke immediately.
  let typingKey = "";
  let typingSnapshot: ProjectData | null = null;
  let typingResetTimer: number | undefined;
  const commitText = (key: string, label: string, mutate: (draft: ProjectData) => void) => {
    const current = structuredClone(project());
    const next = structuredClone(current);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    if (typingKey === key && typingSnapshot) {
      batch(() => {
        setFuture([]);
        setProject(next);
        setRevision((value) => value + 1);
        setLastAction(label);
      });
    } else {
      typingKey = key;
      typingSnapshot = current;
      batch(() => {
        setPast((items) => [...items.slice(-49), current]);
        setFuture([]);
        setProject(next);
        setRevision((value) => value + 1);
        setLastAction(label);
      });
    }
    window.clearTimeout(typingResetTimer);
    typingResetTimer = window.setTimeout(() => {
      typingKey = "";
      typingSnapshot = null;
    }, 1000);
    localDirty = true;
    syncSave();
  };

  /** Fast-forward to an envelope that extends the state this tab knows. */
  const adoptIncoming = (incoming: PersistedEnvelope, notice: string) => {
    const current = structuredClone(project());
    batch(() => {
      setPast((items) => [...items.slice(-49), current]);
      setFuture([]);
      setProject(structuredClone(incoming.project));
      setRevision(incoming.revision);
      setLastAction(notice);
    });
    setBaseSaveId(incoming.saveId);
    setParentSaveId(incoming.saveId);
    localDirty = false;
    setPhase("syncing");
    setConflict(null);
    setSaveStatus(online() ? "saved" : "offline");
    const stillExists = incoming.project.tracks
      .flatMap((track) => track.segments)
      .some((segment) => segment.id === selectedId());
    if (!stillExists) {
      setSelectedId(incoming.project.tracks.find((track) => track.id === incoming.project.activeTrackId)?.segments[0]?.id ?? "");
    }
  };

  const enterForked = (competitor: PersistedEnvelope) => {
    persistDraft(project(), revision(), TAB_ID, competitor.saveId, parentSaveId());
    setBaseSaveId(competitor.saveId);
    localDirty = true;
    setPhase("forked");
    setSaveStatus("offline");
    setConflict({ competitor });
  };

  /**
   * Handle a save observed from another tab, classified by lineage so the
   * physically later writer is the one asked first and the shared draft is
   * never silently clobbered.
   */
  const handleIncoming = (raw: PersistedEnvelope | undefined | null) => {
    if (!raw || raw.tabId === TAB_ID) return;
    const incoming = raw;
    const head = readEnvelope();
    if (!head) return;
    if (incoming.saveId === baseSaveId()) { return; }

    if (conflict()) {
      // Keep the banner pointed at the newest competing envelope.
      setConflict({ competitor: incoming });
      return;
    }

    // Linear continuation of the head we know: silently fast-forward.
    if (isChild(incoming, baseSaveId()) && incoming.saveId === head.saveId) {
      if (!localDirty) { adoptIncoming(incoming, "其他标签页的修改已同步到本页");
        return;
      }
      // We had edits based on the previous head: normal fork, we decide. enterForked(incoming);
      return;
    }

    // A "keep mine" from another tab deliberately replaced a save this tab
    // knew about: the displaced proofreader is told as well.
    if (incoming.forced && incoming.replacedSaveId && (incoming.replacedSaveId === baseSaveId() || incoming.replacedSaveId === parentSaveId())) {
      if (!localDirty && phase() === "syncing") { adoptIncoming(incoming, "另一标签页已保留其版本，本页内容被替换");
        return;
      }
      enterForked(incoming);
      return;
    }

    // The other save diverged from the same shared ancestor — the classic
    // cross-process race where both physical writes "succeeded".
    if (isSibling(head, incoming)) {
      if (head.tabId === TAB_ID) {
        // Our save is physically on top: we are the later writer, so this
        // tab decides first. Park the sibling save for the proofreader.
        const candidate: IncomingCandidate = {
          kind: "incoming-candidate",
          fromTabId: incoming.tabId,
          baseSaveId: head.parentSaveId,
          envelope: incoming,
        };
        writeIncoming(candidate, TAB_ID);
        localDirty = true;
        setPhase("awaiting");
        setSaveStatus("offline");
        setConflict({ competitor: incoming });
      } else {
        // Our save was physically displaced first: stay silent and wait for
        // the other tab's decision. Keep our content parked so it survives
        // reloads; if they adopt ours it returns cleanly, if they force
        // theirs the forced-notice above asks us afterwards.
        persistDraft(project(), revision(), TAB_ID, incoming.saveId, parentSaveId());
        setBaseSaveId(head.saveId);
        localDirty = true;
        setPhase("forked");
        setSaveStatus("offline");
      }
      return;
    }

    // The notification IS the current head from another tab. If our own
    // last save is its sibling, ours lost the physical race: wait silently.
    if (incoming.saveId === head.saveId && head.tabId !== TAB_ID) {
      const own = readOutbox(TAB_ID);
      const lostRace =
        (own && isSibling(own, head)) ||
        (!own && !!parentSaveId() && parentSaveId() !== head.saveId && head.parentSaveId !== parentSaveId() && !isChild(head, parentSaveId()));
      if (lostRace) {
        persistDraft(project(), revision(), TAB_ID, head.saveId, parentSaveId());
        setBaseSaveId(head.saveId);
        localDirty = true;
        setPhase("forked");
        setSaveStatus("offline");
        return;
      }
      // Otherwise it is an unrelated foreign head we cannot reconcile: ask. enterForked(incoming);
    }
  };

  const undo = () => {
    const stack = past();
    if (!stack.length) return;
    const previous = stack[stack.length - 1];
    setFuture((items) => [structuredClone(project()), ...items].slice(0, 50));
    setPast(stack.slice(0, -1));
    setProject(previous);
    setRevision((value) => value + 1);
    setLastAction("已撤销上一步");
    localDirty = true;
    syncSave();
  };

  const redo = () => {
    const stack = future();
    if (!stack.length) return;
    const next = stack[0];
    setPast((items) => [...items.slice(-49), structuredClone(project())]);
    setFuture(stack.slice(1));
    setProject(next);
    setRevision((value) => value + 1);
    setLastAction("已重做");
    localDirty = true;
    syncSave();
  };

  const switchTrack = (trackId: string) => {
    commit("切换文本轨", (draft) => {
      draft.activeTrackId = trackId;
      setSelectedId(draft.tracks.find((track) => track.id === trackId)?.segments[0]?.id ?? "");
    });
  };

  const moveSelection = (direction: 1 | -1) => {
    const segments = activeTrack()?.segments ?? [];
    if (!segments.length) return;
    const index = Math.max(0, segments.findIndex((segment) => segment.id === selectedId()));
    const nextIndex = (index + direction + segments.length) % segments.length;
    setSelectedId(segments[nextIndex].id);
    document.getElementById(`segment-${segments[nextIndex].id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const splitSelection = () => {
    const segment = activeSegment();
    if (!segment || segment.text.trim().length < 2) return;
    const cursor = editorRef?.selectionStart ?? Math.floor(segment.text.length / 2);
    const safeCursor = Math.max(1, Math.min(cursor, segment.text.length - 1));
    const firstText = segment.text.slice(0, safeCursor).trim();
    const secondText = segment.text.slice(safeCursor).trim();
    if (!firstText || !secondText) return;
    const ratio = firstText.length / segment.text.length;
    const boundary = segment.start + (segment.end - segment.start) * ratio;
    const secondId = uid("seg");
    commitSegment("拆分片段", (current, draft) => {
      const original = structuredClone(current);
      current.text = firstText;
      current.end = Number(boundary.toFixed(1));
      const trackIndex = draft.tracks.findIndex((track) => track.id === draft.activeTrackId);
      if (trackIndex >= 0) {
        const segmentIndex = draft.tracks[trackIndex].segments.findIndex((item) => item.id === current.id);
        draft.tracks[trackIndex].segments.splice(segmentIndex + 1, 0, {
          ...original,
          id: secondId,
          start: Number(boundary.toFixed(1)),
          text: secondText,
          reviewed: false,
          comments: [],
        });
      }
      setSelectedId(secondId);
    });
  };

  const mergeWithNext = () => {
    const track = activeTrack();
    const segment = activeSegment();
    if (!track || !segment) return;
    const index = track.segments.findIndex((item) => item.id === segment.id);
    const next = track.segments[index + 1];
    if (!next) return;
    commitSegment("合并下一片段", (current, draft) => {
      current.text = `${current.text.trim()} ${next.text.trim()}`;
      current.end = next.end;
      current.tagIds = [...new Set([...current.tagIds, ...next.tagIds])];
      current.comments.push(...next.comments);
      current.confidence = Math.min(current.confidence, next.confidence) as Confidence;
      const sourceTrack = draft.tracks.find((item) => item.id === draft.activeTrackId);
      sourceTrack?.segments.splice(index + 1, 1);
      current.reviewed = false;
    });
  };

  const toggleFlag = (flag: keyof Segment["flags"]) => {
    commitSegment("修改校对标记", (segment) => {
      segment.flags[flag] = !segment.flags[flag];
      segment.reviewed = false;
    });
  };

  const setConfidence = (confidence: Confidence) => {
    commitSegment("校正置信度", (segment) => {
      segment.confidence = confidence;
      segment.flags.lowConfidence = confidence <= 2;
      segment.reviewed = false;
    });
  };

  const addComment = () => {
    const body = commentDraft().trim();
    if (!body) return;
    commitSegment("添加批注", (segment) => {
      segment.comments.unshift({
        id: uid("comment"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      segment.reviewed = false;
    });
    setCommentDraft("");
  };

  const addReply = (commentId: string) => {
    const body = (replyDrafts()[commentId] ?? "").trim();
    if (!body) return;
    commitSegment("回复批注", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      comment?.replies.push({
        id: uid("reply"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
      });
    });
    setReplyDrafts((drafts) => ({ ...drafts, [commentId]: "" }));
  };

  const toggleComment = (commentId: string) => {
    commitSegment("更新批注状态", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  const toggleTag = (tagId: string) => {
    commitSegment("更新主题关联", (segment) => {
      segment.tagIds = segment.tagIds.includes(tagId)
        ? segment.tagIds.filter((id) => id !== tagId)
        : [...segment.tagIds, tagId];
      segment.reviewed = false;
    });
  };

  const exportSrt = () => {
    const lines = activeTrack().segments.map((segment, index) => {
      const speaker = speakerById(segment.speakerId)?.name ?? "未知";
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${segment.text}\n`;
    });
    downloadText(`${project().title}-${activeTrack().name}.srt`, lines.join("\n"), "application/x-subrip;charset=utf-8");
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const imported = parseTimedTranscript(text, file.name.replace(/\.[^.]+$/, ""));
    if (!imported.segments.length) {
      setLastAction("未识别到带时间码的文本");
      return;
    }
    commit("导入转写文本", (draft) => {
      draft.tracks.push(imported);
      draft.activeTrackId = imported.id;
      setSelectedId(imported.segments[0].id);
    });
  };

  /** Use the competing version and continue on top of it. */
  const chooseIncoming = (competitor: PersistedEnvelope) => {
    resolveWithIncoming(competitor, TAB_ID);
    adoptIncoming(competitor, "已采用另一标签页的版本");
    channel?.postMessage({ type: "sologsb-save", envelope: competitor });
  };

  /** Keep this tab's content and promote it to the shared head. */
  const chooseLocal = (competitor: PersistedEnvelope) => {
    // Race this tab "won" (its save is still the head): mark the same
    // envelope as a deliberate overwrite so the other tab is informed.
    const head = readEnvelope();
    const own = readOutbox(TAB_ID);
    let envelope: PersistedEnvelope;
    if (phase() === "awaiting" && head && own && head.saveId === own.saveId && head.saveId === parentSaveId()) {
      envelope = promoteOutboxForced(own, competitor.saveId);
      setRevision((value) => value + 1);
    } else {
      envelope = forceSaveLocal(project(), revision(), TAB_ID, competitor.saveId, parentSaveId());
      setBaseSaveId(envelope.saveId);
      setParentSaveId(envelope.saveId);
      setRevision((value) => value + 1);
    }
    localDirty = false;
    setPhase("syncing");
    setConflict(null);
    setSaveStatus(online() ? "saved" : "offline");
    setLastAction("已保留本页版本并覆盖另一份草稿");
    channel?.postMessage({ type: "sologsb-save", envelope });
  };

  /** Last-chance persistence when the page is hidden or unloaded. */
  const flushBeforeHide = () => {
    if (phase() === "forked" || phase() === "awaiting") {
      persistDraft(project(), revision(), TAB_ID, conflict()?.competitor.saveId ?? baseSaveId(), parentSaveId());
      return;
    }
    if (!localDirty) return;
    const outcome = saveProject(project(), revision(), TAB_ID, baseSaveId(), parentSaveId());
    if (outcome.status === "diverged") {
      persistDraft(project(), revision(), TAB_ID, outcome.head.saveId, parentSaveId());
    }
  };

  onMount(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "sologsb-1007-project-v1" || !event.newValue) return;
      try {
        handleIncoming(JSON.parse(event.newValue) as PersistedEnvelope);
      } catch {
        // Ignore unrelated or malformed storage events.
      }
    };
    const handleChannelMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; envelope?: PersistedEnvelope } | PersistedEnvelope;
      const envelope = data && typeof data === "object" && "type" in data ? data.envelope : (data as PersistedEnvelope);
      handleIncoming(envelope);
    };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (conflict()) {
          setLastAction("存在未解决的多标签页冲突，请先选择保留哪份内容");
          return;
        }
        if (localDirty) syncSave();
        setSaveStatus(online() ? "saved" : "offline");
        setLastAction("已保存本地草稿");
        return;
      }
      if (editing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        mergeWithNext();
      } else if (event.key.toLowerCase() === "r" && activeSegment()) {
        event.preventDefault();
        commitSegment("标记片段已校对", (segment) => { segment.reviewed = true; });
      } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    window.addEventListener("pagehide", flushBeforeHide);
    document.addEventListener("visibilitychange", flushBeforeHide);
    window.addEventListener("keydown", handleKeydown);
    channel?.addEventListener("message", handleChannelMessage);
    setOnline(navigator.onLine);
    onCleanup(() => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("pagehide", flushBeforeHide);
      document.removeEventListener("visibilitychange", flushBeforeHide);
      window.removeEventListener("keydown", handleKeydown);
      channel?.removeEventListener("message", handleChannelMessage);
    });
  });

  onCleanup(() => {
    window.clearTimeout(typingResetTimer);
    channel?.close();
  });

  const clickSegment = (id: string) => {
    setSelectedId(id);
    queueMicrotask(() => editorRef?.focus());
  };

  return (
    <div class="app-shell">
      <Show when={conflict()}>
        {(state) => (
          <div class="conflict-banner" role="alert">
            <div>
              <strong>
                {phase() === "awaiting"
                  ? "另一标签页已从本页版本分叉，等待您决定保留哪份内容"
                  : "两个标签页已从同一版本分叉，请选择保留哪份内容"}
              </strong>
              <span>
                另一版本保存于 {new Date(state().competitor.savedAt).toLocaleTimeString()}（版本 {state().competitor.revision + 1}）；
                本页的批注与修改已另存为独立草稿，刷新也不会丢失。系统不会自动合并，以免盖掉人工校对结果。
              </span>
            </div>
            <div class="conflict-actions">
              <button class="btn btn-quiet" onClick={() => chooseLocal(state().competitor)}>保留本页</button>
              <button class="btn btn-danger" onClick={() => chooseIncoming(state().competitor)}>载入对方版本</button>
            </div>
          </div>
        )}
      </Show>

      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><span>口述</span><b>1007</b></div>
        <div class="project-heading">
          <input
            aria-label="项目标题"
            value={project().title}
            onInput={(event) => {
              if (event.isComposing) return;
              const value = event.currentTarget.value;
              commitText("project-title", "修改项目标题", (draft) => { draft.title = value; });
            }}
            onCompositionEnd={(event) => {
              const value = event.currentTarget.value;
              commitText("project-title", "修改项目标题", (draft) => { draft.title = value; });
            }}
          />
          <div class="project-meta">
            <span>{project().interviewee}</span>
            <span>{project().recordingDate}</span>
            <span class={`save-state ${saveStatus()}`}>{statusText(saveStatus())}</span>
          </div>
        </div>
        <div class="top-actions">
          <span class={`network-chip ${online() ? "online" : "offline"}`}>{online() ? "在线" : "离线可编辑"}</span>
          <button class="icon-btn" title="撤销 Ctrl/Cmd+Z" disabled={!past().length} onClick={undo}>↶</button>
          <button class="icon-btn" title="重做 Ctrl/Cmd+Shift+Z" disabled={!future().length} onClick={redo}>↷</button>
          <button class="btn btn-quiet" onClick={() => setHelpOpen(true)}>快捷键 <kbd>?</kbd></button>
          <button class="btn btn-primary" onClick={exportSrt}>导出 SRT</button>
        </div>
      </header>

      <div class="workspace">
        <aside class="left-panel">
          <section class="panel-section overview-card">
            <div class="eyebrow">校对进度</div>
            <div class="progress-row">
              <strong>{completedPercent()}%</strong>
              <span>{project().tracks.flatMap((track) => track.segments).filter((segment) => segment.reviewed).length} / {project().tracks.flatMap((track) => track.segments).length} 片段</span>
            </div>
            <div class="progress-track"><i style={{ width: `${completedPercent()}%` }} /></div>
            <p>每次修改即时写入本机；断网或刷新后仍可继续校对。</p>
          </section>

          <section class="panel-section">
            <div class="section-title"><h2>文本轨道</h2><span>{project().tracks.length}</span></div>
            <div class="track-list">
              <For each={project().tracks}>
                {(track) => (
                  <button class={`track-card ${track.id === project().activeTrackId ? "active" : ""}`} onClick={() => switchTrack(track.id)}>
                    <span class="track-icon">{track.language === "English" ? "EN" : track.language === "福州话转写" ? "方" : "普"}</span>
                    <span class="track-info"><strong>{track.name}</strong><small>{track.segments.length} 段 · {track.status}</small></span>
                    <span class="track-dot" style={{ background: track.status === "已完成" ? "#15803d" : track.status === "校对中" ? "#d97706" : "#94a3b8" }} />
                  </button>
                )}
              </For>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.txt,.vtt"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => fileInputRef?.click()}><span>＋</span> 导入带时间码文本</button>
            <div class="hint">支持 SRT / VTT / 每行 `[00:12] 文本`</div>
          </section>

          <section class="panel-section tag-summary">
            <div class="section-title"><h2>标注实体</h2><span>{project().tags.length}</span></div>
            <div class="legend">
              <span><i style={{ background: "#2563eb" }} />主题</span>
              <span><i style={{ background: "#b45309" }} />事件</span>
              <span><i style={{ background: "#be185d" }} />人物</span>
            </div>
            <p>在右侧“标注”页把当前片段关联到主题、事件和人物。</p>
          </section>
        </aside>

        <main class="transcript-panel">
          <div class="panel-toolbar">
            <div>
              <div class="eyebrow">当前轨道</div>
              <h1>{activeTrack().name}</h1>
            </div>
            <div class="filters" role="group" aria-label="片段筛选">
              <button class={trackFilter() === "all" ? "active" : ""} onClick={() => setTrackFilter("all")}>全部</button>
              <button class={trackFilter() === "unreviewed" ? "active" : ""} onClick={() => setTrackFilter("unreviewed")}>未校对</button>
              <button class={trackFilter() === "low" ? "active" : ""} onClick={() => setTrackFilter("low")}>低置信</button>
            </div>
          </div>

          <div class="transcript-list" role="listbox" aria-label="转写片段">
            <For each={visibleSegments()}>
              {(segment, index) => (
                <article
                  id={`segment-${segment.id}`}
                  role="option"
                  aria-selected={segment.id === selectedId()}
                  class={`segment-card ${segment.id === selectedId() ? "selected" : ""} ${segment.reviewed ? "reviewed" : ""}`}
                  onClick={() => clickSegment(segment.id)}
                >
                  <div class="segment-rail" style={{ background: speakerById(segment.speakerId)?.color ?? "#64748b" }} />
                  <div class="segment-time">
                    <span>{formatTime(segment.start, false)}</span>
                    <small>{formatTime(segment.end, false)}</small>
                  </div>
                  <div class="segment-body">
                    <div class="segment-meta">
                      <b>{speakerById(segment.speakerId)?.name ?? "未知发言人"}</b>
                      <span class={`confidence c${segment.confidence}`}>置信 {segment.confidence}/5</span>
                      <Show when={segment.flags.lowConfidence}><span class="pill alert">低置信</span></Show>
                      <Show when={segment.flags.dialect}><span class="pill dialect">方言</span></Show>
                      <Show when={segment.flags.properNoun}><span class="pill proper">专名</span></Show>
                      <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
                    </div>
                    <p>{segment.text}</p>
                    <div class="segment-tags">
                      <For each={segment.tagIds.map(tagById).filter(Boolean)}>
                        {(tag) => <span style={{ "--tag-color": tag!.color } as any}>#{tag!.label}</span>}
                      </For>
                    </div>
                  </div>
                  <span class="segment-index">{index() + 1}</span>
                </article>
              )}
            </For>
            <Show when={!visibleSegments().length}>
              <div class="empty-state"><b>没有符合筛选条件的片段</b><span>切换到“全部”继续校对。</span></div>
            </Show>
          </div>
        </main>

        <aside class="inspector">
          <Show when={activeSegment()} fallback={<div class="empty-inspector"><b>选择一个片段</b><p>在中间列表点击片段后即可校正发言人、置信度、标记和批注。</p></div>}>
            {(segment) => (
              <Tabs defaultValue="correct" class="inspector-tabs">
                <Tabs.List class="tab-list">
                  <Tabs.Trigger value="correct">校对</Tabs.Trigger>
                  <Tabs.Trigger value="annotate">标注</Tabs.Trigger>
                  <Tabs.Trigger value="comments">批注 <span>{segment().comments.length}</span></Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="correct" class="tab-content">
                  <div class="inspector-heading">
                    <div><span>片段 {activeTrack().segments.findIndex((item) => item.id === segment().id) + 1}</span><strong>{formatTime(segment().start, false)} — {formatTime(segment().end, false)}</strong></div>
                    <button class={`review-button ${segment().reviewed ? "done" : ""}`} onClick={() => commitSegment("标记片段已校对", (item) => { item.reviewed = true; })}>
                      {segment().reviewed ? "✓ 已校对" : "标记已校对"}
                    </button>
                  </div>

                  <label class="field-label" for="speaker-select">发言人</label>
                  <select
                    id="speaker-select"
                    value={segment().speakerId}
                    onChange={(event) => commitSegment("校正发言人", (item) => { item.speakerId = event.currentTarget.value; item.reviewed = false; })}
                  >
                    <For each={project().speakers}>{(speaker) => <option value={speaker.id}>{speaker.name} · {speaker.role}</option>}</For>
                  </select>

                  <div class="time-grid">
                    <label>开始<input type="text" value={formatTime(segment().start)} onChange={(event) => commitSegment("修改开始时间", (item) => { item.start = parseTime(event.currentTarget.value); })} /></label>
                    <label>结束<input type="text" value={formatTime(segment().end)} onChange={(event) => commitSegment("修改结束时间", (item) => { item.end = parseTime(event.currentTarget.value); })} /></label>
                  </div>

                  <label class="field-label" for="transcript-editor">转写文本</label>
                  <textarea
                    id="transcript-editor"
                    ref={editorRef}
                    rows="7"
                    value={segment().text}
                    onInput={(event) => {
                      if (event.isComposing) return;
                      const value = event.currentTarget.value;
                      const cursor = event.currentTarget.selectionStart;
                      commitText(`segment-text-${selectedId()}`, "校正转写文本", (draft) => {
                        const track = draft.tracks.find((item) => item.id === draft.activeTrackId);
                        const target = track?.segments.find((item) => item.id === selectedId());
                        if (target) {
                          target.text = value;
                          target.reviewed = false;
                        }
                      });
                      queueMicrotask(() => {
                        if (document.activeElement === editorRef && editorRef) editorRef.selectionStart = editorRef.selectionEnd = cursor;
                      });
                    }}
                    onCompositionEnd={(event) => {
                      const value = event.currentTarget.value;
                      commitText(`segment-text-${selectedId()}`, "校正转写文本", (draft) => {
                        const track = draft.tracks.find((item) => item.id === draft.activeTrackId);
                        const target = track?.segments.find((item) => item.id === selectedId());
                        if (target) {
                          target.text = value;
                          target.reviewed = false;
                        }
                      });
                    }}
                  />
                  <div class="textarea-help">光标停在句中后点击“拆分”，系统会保留两侧时间码比例。</div>

                  <div class="field-label">置信度</div>
                  <div class="confidence-picker" role="radiogroup" aria-label="置信度">
                    <For each={[1, 2, 3, 4, 5] as Confidence[]}>
                      {(value) => <button class={segment().confidence === value ? "active" : ""} onClick={() => setConfidence(value)}>{value}</button>}
                    </For>
                  </div>

                  <div class="field-label">校对标记</div>
                  <div class="flag-list">
                    <Checkbox checked={segment().flags.lowConfidence} onChange={() => toggleFlag("lowConfidence")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>低置信词或句</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.dialect} onChange={() => toggleFlag("dialect")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>方言表达</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.properNoun} onChange={() => toggleFlag("properNoun")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>专有名词</Checkbox.Label>
                    </Checkbox>
                  </div>

                  <div class="split-actions">
                    <button onClick={splitSelection}>⌁ 按光标拆分</button>
                    <button disabled={activeTrack().segments.at(-1)?.id === segment().id} onClick={mergeWithNext}>合 合并下一段</button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="annotate" class="tab-content">
                  <div class="content-title"><h3>关联主题、事件与人物</h3><p>一个片段可关联多个实体，复核后颜色会显示在列表中。</p></div>
                  <For each={project().tags}>
                    {(tag) => (
                      <button class={`tag-option ${segment().tagIds.includes(tag.id) ? "selected" : ""}`} onClick={() => toggleTag(tag.id)}>
                        <i style={{ background: tag.color }} />
                        <span><strong>#{tag.label}</strong><small>{tag.type === "topic" ? "主题" : tag.type === "event" ? "事件" : "人物"}</small></span>
                        <b>{segment().tagIds.includes(tag.id) ? "✓" : "＋"}</b>
                      </button>
                    )}
                  </For>
                </Tabs.Content>

                <Tabs.Content value="comments" class="tab-content comments-content">
                  <div class="content-title"><h3>批注与回复</h3><p>批注不会改写原文，可保留校对依据并继续讨论。</p></div>
                  <div class="comment-compose">
                    <textarea rows="3" placeholder="记录读音、词义或专名依据…" value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)} />
                    <button class="btn btn-primary" onClick={addComment}>添加批注</button>
                  </div>
                  <For each={segment().comments} fallback={<div class="mini-empty">当前片段还没有批注。</div>}>
                    {(comment) => (
                      <article class={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                        <header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></header>
                        <p>{comment.body}</p>
                        <For each={comment.replies}>
                          {(reply) => <div class="reply"><b>{reply.author}</b><span>{reply.body}</span></div>}
                        </For>
                        <div class="reply-row">
                          <input
                            value={replyDrafts()[comment.id] ?? ""}
                            placeholder="回复…"
                            onInput={(event) => setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: event.currentTarget.value }))}
                            onKeyDown={(event) => { if (event.key === "Enter") addReply(comment.id); }}
                          />
                          <button onClick={() => addReply(comment.id)}>回复</button>
                        </div>
                        <button class="resolve-link" onClick={() => toggleComment(comment.id)}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                      </article>
                    )}
                  </For>
                </Tabs.Content>
              </Tabs>
            )}
          </Show>
        </aside>
      </div>

      <footer class="statusbar">
        <span>最近操作：{lastAction()}</span>
        <span>版本 {revision() + 1} · 本地草稿</span>
        <span class="status-shortcuts">J/K 浏览　R 已校对　M 合并　? 帮助</span>
      </footer>

      <Dialog open={helpOpen()} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>键盘校对</Dialog.Title>
            <Dialog.Description>光标在输入框中时，单键快捷键不会抢占文字输入。</Dialog.Description>
            <div class="shortcut-grid">
              <span><kbd>J</kbd><kbd>↓</kbd> 下一片段</span>
              <span><kbd>K</kbd><kbd>↑</kbd> 上一片段</span>
              <span><kbd>R</kbd> 标记已校对</span>
              <span><kbd>M</kbd> 合并下一片段</span>
              <span><kbd>Ctrl/⌘ Z</kbd> 撤销</span>
              <span><kbd>Ctrl/⌘ ⇧ Z</kbd> 重做</span>
              <span><kbd>Ctrl/⌘ S</kbd> 立即保存</span>
              <span><kbd>?</kbd> 显示本帮助</span>
            </div>
            <div class="dialog-footer"><button class="btn btn-primary" onClick={() => setHelpOpen(false)}>开始校对</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
