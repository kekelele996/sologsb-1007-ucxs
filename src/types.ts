export type Confidence = 1 | 2 | 3 | 4 | 5;

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface Speaker {
  id: string;
  name: string;
  role: string;
  color: string;
}

export interface Tag {
  id: string;
  label: string;
  type: "topic" | "event" | "person";
  color: string;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  speakerId: string;
  text: string;
  confidence: Confidence;
  reviewed: boolean;
  flags: {
    lowConfidence: boolean;
    dialect: boolean;
    properNoun: boolean;
  };
  tagIds: string[];
  comments: ReviewComment[];
}

export interface TranscriptTrack {
  id: string;
  name: string;
  language: string;
  status: "待校对" | "校对中" | "已完成";
  segments: Segment[];
}

export interface ProjectData {
  id: string;
  title: string;
  interviewee: string;
  recordingDate: string;
  activeTrackId: string;
  speakers: Speaker[];
  tags: Tag[];
  tracks: TranscriptTrack[];
  updatedAt: string;
}

/**
 * - revision: monotonically increasing logical clock, one tick per save.
 * - kind "fork" means the writer kept its own content after seeing a
 *   divergent tip; supersedesRevision records the tip it deliberately replaced.
 */
export interface PersistedEnvelope {
  schema: 1;
  id: string;
  /** Envelope id this save was built on top of. */
  parentId?: string;
  revision: number;
  tabId: string;
  savedAt: number;
  kind: "normal" | "fork";
  supersedesRevision?: number;
  project: ProjectData;
}

/** Local edits that never made it to the main draft because a fork was detected. */
export interface PendingDraft {
  id: string;
  tabId: string;
  baseRevision: number;
  savedAt: number;
  project: ProjectData;
}

/** Free-text the proofreader typed but had not submitted before a reload. */
export interface ComposerDrafts {
  text: Record<string, string>;
  comment: Record<string, string>;
  reply: Record<string, string>;
}
