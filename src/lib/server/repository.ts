import path from "node:path";
import {
  ANALYSIS_WINDOW_MS,
  DEFAULT_TEMPLATE_FONT_FAMILY,
  DEFAULT_TEMPLATE_FONT_SOURCE,
  LIVE_VIDEO_RETENTION_MS,
  RENDERER_VERSION,
  SEGMENT_MS,
  SUBTITLE_MODE,
} from "@/lib/config";
import type {
  AnalyzerDecision,
  CaptionPlacement,
  CandidateStatus,
  ClipCandidate,
  IngestionRun,
  RenderConfig,
  DriveUploadStatus,
  RenderFormat,
  RenderJob,
  RenderTemplate,
  RunDetail,
  RunStatus,
  SubtitleCue,
  TranscriptToken,
  TranscriptWindow,
  VideoFillMode,
} from "@/lib/types";
import type { EditDirectionPlan } from "./edit-direction";
import { createId, createStableHash, detectPlatform, normalizeSourceUrl, safeJsonParse } from "@/lib/utils";
import { getDb } from "./db";
import { ensureRunDirectories } from "./fs";

type RunRow = {
  id: string;
  source_url: string;
  platform: IngestionRun["platform"];
  label: string;
  status: RunStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string;
  storage_dir: string;
  capture_cursor_ms: number;
  last_segment_at: string | null;
  last_analysis_at: string | null;
  drive_folder_id: string | null;
  auto_approve_clips: number;
  source_mode: IngestionRun["sourceMode"];
  source_duration_ms: number | null;
  source_media_strategy: IngestionRun["sourceMediaStrategy"];
  analysis_audio_path: string | null;
  temp_video_retention_ms: number | null;
  last_capture_error_code: IngestionRun["lastCaptureErrorCode"];
};

type CandidateRow = {
  id: string;
  run_id: string;
  suggested_start_ms: number;
  suggested_end_ms: number;
  confidence: number;
  reason: string;
  title: string;
  hook: string;
  keywords_json: string;
  render_config_json: string | null;
  compaction_status: ClipCandidate["compactionStatus"];
  compaction_mode: ClipCandidate["compactionMode"];
  compact_start_ms: number | null;
  compact_end_ms: number | null;
  status: CandidateStatus;
  created_at: string;
  updated_at: string;
};

type RenderRow = {
  id: string;
  run_id: string;
  candidate_id: string;
  format: RenderFormat;
  render_config_json: string | null;
  render_signature: string | null;
  renderer_version: string | null;
  caption_timing_offset_ms: number | null;
  status: RenderJob["status"];
  progress_percent: number | null;
  output_path: string | null;
  drive_file_id: string | null;
  drive_folder_id: string | null;
  drive_web_view_link: string | null;
  drive_upload_status: DriveUploadStatus | null;
  drive_error_message: string | null;
  telegram_notified_at: string | null;
  source_strategy: RenderJob["sourceStrategy"];
  clip_spans_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type TemplateRow = {
  id: string;
  name: string;
  mode: RenderTemplate["mode"];
  ai_motion_enabled: number;
  motion_intensity: RenderTemplate["motionIntensity"];
  allow_punch_ins: number;
  max_motion_events: number;
  enable_captions: number;
  enable_motion: number;
  enable_color: number;
  enable_music: number;
  enable_compaction: number;
  color_grade_preset: RenderTemplate["colorGradePreset"];
  ai_music_enabled: number;
  intro_src: string | null;
  music_src: string | null;
  caption_style: RenderTemplate["captionStyle"];
  caption_size: RenderTemplate["captionSize"];
  caption_color: string;
  caption_placement: CaptionPlacement;
  music_volume: number;
  music_fade_in: number;
  music_fade_out: number;
  outro_src: string | null;
  video_layout: RenderFormat;
  video_fill_mode: VideoFillMode | null;
  font_family: string | null;
  font_source: RenderTemplate["fontSource"] | null;
  subtitle_mode: RenderTemplate["subtitleMode"] | null;
  created_at: string;
  updated_at: string;
};

type SubtitleCueRow = {
  id: string;
  render_id: string;
  candidate_id: string;
  run_id: string;
  cue_index: number;
  text: string;
  start_ms: number;
  end_ms: number;
  is_hidden: number;
  source_token_ids_json: string;
  edit_source: SubtitleCue["editSource"];
  created_at: string;
  updated_at: string;
};

const RENDER_SIGNATURE_VERSION = 7;

export type SegmentRecord = {
  id: string;
  runId: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  status: string;
  videoPath: string;
  transcriptPath: string | null;
  errorMessage: string | null;
  mediaType: "audio" | "video" | "approved_video";
  retentionStatus: "temporary" | "retained" | "deleted";
  expiresAt: string | null;
  createdAt: string;
  processedAt: string | null;
};

function mapRun(row: RunRow): IngestionRun {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    platform: row.platform,
    label: row.label,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    storageDir: row.storage_dir,
    captureCursorMs: row.capture_cursor_ms,
    lastSegmentAt: row.last_segment_at,
    lastAnalysisAt: row.last_analysis_at,
    driveFolderId: row.drive_folder_id,
    autoApproveClips: Boolean(row.auto_approve_clips),
    sourceMode: row.source_mode ?? "unknown",
    sourceDurationMs: row.source_duration_ms,
    sourceMediaStrategy: row.source_media_strategy ?? "legacy_segment_video",
    analysisAudioPath: row.analysis_audio_path,
    tempVideoRetentionMs: row.temp_video_retention_ms,
    lastCaptureErrorCode: row.last_capture_error_code ?? null,
  };
}

function mapCandidate(row: CandidateRow): ClipCandidate {
  return {
    id: row.id,
    runId: row.run_id,
    suggestedStartMs: row.suggested_start_ms,
    suggestedEndMs: row.suggested_end_ms,
    confidence: row.confidence,
    reason: row.reason,
    title: row.title,
    hook: row.hook,
    keywords: safeJsonParse<string[]>(row.keywords_json, []),
    renderConfig: safeJsonParse<RenderConfig | null>(row.render_config_json ?? "null", null),
    status: row.status,
    compactionStatus: row.compaction_status ?? "pending",
    compactionMode: row.compaction_mode,
    compactStartMs: row.compact_start_ms,
    compactEndMs: row.compact_end_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRender(row: RenderRow): RenderJob {
  const isRendered = row.status === "rendered";
  return {
    id: row.id,
    runId: row.run_id,
    candidateId: row.candidate_id,
    format: row.format,
    renderConfig: safeJsonParse<RenderConfig | null>(row.render_config_json ?? "null", null),
    renderSignature: row.render_signature,
    rendererVersion: row.renderer_version,
    captionTimingOffsetMs: row.caption_timing_offset_ms,
    status: row.status,
    progressPercent: isRendered ? null : row.progress_percent,
    outputPath: row.output_path,
    driveFileId: row.drive_file_id,
    driveFolderId: row.drive_folder_id,
    driveWebViewLink: row.drive_web_view_link,
    driveUploadStatus: row.drive_upload_status ?? "not_configured",
    driveErrorMessage: row.drive_error_message,
    telegramNotifiedAt: row.telegram_notified_at,
    errorMessage: isRendered ? null : row.error_message,
    sourceStrategy: row.source_strategy ?? "continuous",
    clipSpansJson: row.clip_spans_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTemplate(row: TemplateRow): RenderTemplate {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode ?? "edited",
    aiMotionEnabled: Boolean(row.ai_motion_enabled ?? 1),
    motionIntensity: row.motion_intensity ?? "subtle",
    allowPunchIns: Boolean(row.allow_punch_ins ?? 1),
    maxMotionEvents: row.max_motion_events ?? 4,
    enableCaptions: Boolean(row.enable_captions ?? 1),
    enableMotion: Boolean(row.enable_motion ?? 1),
    enableColor: Boolean(row.enable_color ?? 1),
    enableMusic: Boolean(row.enable_music ?? 0),
    enableCompaction: Boolean(row.enable_compaction ?? 1),
    colorGradePreset: row.color_grade_preset ?? "neutral",
    aiMusicEnabled: Boolean(row.ai_music_enabled ?? 0),
    introSrc: row.intro_src,
    musicSrc: row.music_src,
    captionStyle: row.caption_style,
    captionSize: row.caption_size,
    captionColor: row.caption_color,
    captionPlacement: row.caption_placement,
    musicVolume: row.music_volume,
    musicFadeIn: Boolean(row.music_fade_in),
    musicFadeOut: Boolean(row.music_fade_out),
    outroSrc: row.outro_src,
    videoLayout: row.video_layout,
    videoFillMode: row.video_fill_mode ?? "blur",
    fontFamily: row.font_family ?? DEFAULT_TEMPLATE_FONT_FAMILY,
    fontSource: row.font_source ?? (DEFAULT_TEMPLATE_FONT_SOURCE as RenderTemplate["fontSource"]),
    subtitleMode: row.subtitle_mode ?? (SUBTITLE_MODE as RenderTemplate["subtitleMode"]),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSubtitleCue(row: SubtitleCueRow): SubtitleCue {
  return {
    id: row.id,
    renderId: row.render_id,
    candidateId: row.candidate_id,
    runId: row.run_id,
    cueIndex: row.cue_index,
    text: row.text,
    startMs: row.start_ms,
    endMs: row.end_ms,
    isHidden: Boolean(row.is_hidden),
    sourceTokenIds: safeJsonParse<string[]>(row.source_token_ids_json, []),
    editSource: row.edit_source ?? "generated",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureSubtitleCueTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS subtitle_cues (
      id TEXT PRIMARY KEY,
      render_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      cue_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      source_token_ids_json TEXT NOT NULL DEFAULT '[]',
      edit_source TEXT NOT NULL DEFAULT 'generated',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (render_id) REFERENCES render_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subtitle_cues_render ON subtitle_cues(render_id, cue_index);
    CREATE INDEX IF NOT EXISTS idx_subtitle_cues_candidate ON subtitle_cues(candidate_id, cue_index);
  `);
}

function cleanRenderHistory<
  T extends {
    candidateId: string;
    format?: RenderJob["format"];
    renderSignature?: string | null;
    status: RenderJob["status"];
  },
>(renders: T[]) {
  const getRenderKey = (render: T) =>
    [render.candidateId, render.format ?? "unknown", render.renderSignature ?? "legacy"].join(":");
  const renderedByCandidate = new Set(
    renders.filter((render) => render.status === "rendered").map((render) => getRenderKey(render)),
  );

  return renders.filter((render) => {
    if (render.status === "rendered") {
      return true;
    }

    return !renderedByCandidate.has(getRenderKey(render));
  });
}

function canonicalizeSegments(segments: SegmentRecord[]) {
  const byIndex = new Map<number, SegmentRecord>();
  for (const segment of [...segments].sort((left, right) => {
    if (left.segmentIndex !== right.segmentIndex) {
      return left.segmentIndex - right.segmentIndex;
    }

    return right.createdAt.localeCompare(left.createdAt);
  })) {
    if (!byIndex.has(segment.segmentIndex)) {
      byIndex.set(segment.segmentIndex, segment);
    }
  }

  return Array.from(byIndex.values()).sort((left, right) => left.segmentIndex - right.segmentIndex);
}

export function createRun(input: { url: string; label?: string }) {
  const db = getDb();
  const id = createId("run");
  const now = new Date().toISOString();
  const sourceUrl = normalizeSourceUrl(input.url);
  const platform = detectPlatform(sourceUrl);
  const label = input.label?.trim() || `${platform === "unknown" ? "Live source" : platform} run`;
  const storageRoot = ensureRunDirectories(id).root;

  db.prepare(
    `
      INSERT INTO runs (
        id, source_url, platform, label, status, error_message, created_at, updated_at,
        started_at, storage_dir, capture_cursor_ms, last_segment_at, last_analysis_at, drive_folder_id,
        auto_approve_clips, source_mode, source_duration_ms, source_media_strategy, analysis_audio_path,
        temp_video_retention_ms, last_capture_error_code
      )
      VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, 0, NULL, NULL, NULL, 0, 'unknown', NULL, 'legacy_segment_video', NULL, ?, NULL)
    `,
  ).run(id, sourceUrl, platform, label, now, now, now, storageRoot, LIVE_VIDEO_RETENTION_MS);

  return getRunDetail(id);
}

export function listRuns() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM runs ORDER BY datetime(created_at) DESC").all() as RunRow[];

  return rows.map(mapRun);
}

export function getRun(runId: string) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  return row ? mapRun(row) : null;
}

export function getRunDetail(runId: string): RunDetail | null {
  const run = getRun(runId);
  if (!run) {
    return null;
  }

  const segments = listSegments(runId);
  const transcript = getTranscriptWindow(runId);
  const fullTranscriptTokens = listRecentTokens(runId, 0);
  const candidates = listCandidatesForRun(runId).map((candidate) => ({
    ...candidate,
    clipSpans: listClipSpans(candidate.id),
  }));
  const renderJobs = listRenderJobsForRun(runId);
  const capturedMediaMs = segments
    .filter((segment) => segment.status === "downloaded" || segment.status === "processed")
    .reduce((maxMs, segment) => Math.max(maxMs, segment.endMs), 0);
  const capturedTranscriptMs = segments
    .filter((segment) => segment.status === "processed")
    .reduce((maxMs, segment) => Math.max(maxMs, segment.endMs), 0);

  return {
    run,
    capturedMediaMs,
    capturedTranscriptMs,
    transcript,
    fullTranscriptTokens,
    candidates,
    renderJobs,
  };
}

export function getRunSummary(runId: string) {
  const db = getDb();
  const pendingClips = (db
    .prepare("SELECT COUNT(*) AS count FROM candidates WHERE run_id = ? AND status = 'pending'")
    .get(runId) as { count: number } | undefined)?.count ?? 0;
  const renderedClips = (db
    .prepare("SELECT COUNT(DISTINCT candidate_id) AS count FROM render_jobs WHERE run_id = ? AND status = 'rendered'")
    .get(runId) as { count: number } | undefined)?.count ?? 0;
  const capturedMediaMs = (db
    .prepare(
      `
        SELECT COALESCE(MAX(end_ms), 0) AS capturedMs
        FROM segments
        WHERE run_id = ? AND status IN ('downloaded', 'processed')
      `,
    )
    .get(runId) as { capturedMs: number } | undefined)?.capturedMs ?? 0;
  const capturedTranscriptMs = (db
    .prepare(
      `
        SELECT COALESCE(MAX(end_ms), 0) AS capturedMs
        FROM segments
        WHERE run_id = ? AND status = 'processed'
      `,
    )
    .get(runId) as { capturedMs: number } | undefined)?.capturedMs ?? 0;

  return {
    pendingClips,
    renderedClips,
    capturedMediaMs,
    capturedTranscriptMs,
  };
}

export function markRun(runId: string, updates: Partial<Pick<
  IngestionRun,
  | "status"
  | "errorMessage"
  | "captureCursorMs"
  | "lastSegmentAt"
  | "lastAnalysisAt"
  | "sourceMode"
  | "sourceDurationMs"
  | "sourceMediaStrategy"
  | "analysisAudioPath"
  | "tempVideoRetentionMs"
  | "lastCaptureErrorCode"
>>) {
  const db = getDb();
  const existing = getRun(runId);
  if (!existing) {
    return null;
  }

  const updated = {
    status: updates.status ?? existing.status,
    errorMessage: updates.errorMessage === undefined ? existing.errorMessage : updates.errorMessage,
    captureCursorMs: updates.captureCursorMs ?? existing.captureCursorMs,
    lastSegmentAt: updates.lastSegmentAt === undefined ? existing.lastSegmentAt : updates.lastSegmentAt,
    lastAnalysisAt: updates.lastAnalysisAt === undefined ? existing.lastAnalysisAt : updates.lastAnalysisAt,
    sourceMode: updates.sourceMode ?? existing.sourceMode,
    sourceDurationMs: updates.sourceDurationMs === undefined ? existing.sourceDurationMs : updates.sourceDurationMs,
    sourceMediaStrategy: updates.sourceMediaStrategy ?? existing.sourceMediaStrategy,
    analysisAudioPath: updates.analysisAudioPath === undefined ? existing.analysisAudioPath : updates.analysisAudioPath,
    tempVideoRetentionMs:
      updates.tempVideoRetentionMs === undefined ? existing.tempVideoRetentionMs : updates.tempVideoRetentionMs,
    lastCaptureErrorCode:
      updates.lastCaptureErrorCode === undefined ? existing.lastCaptureErrorCode : updates.lastCaptureErrorCode,
    updatedAt: new Date().toISOString(),
  };

  db.prepare(
    `
      UPDATE runs
      SET status = ?, error_message = ?, capture_cursor_ms = ?, last_segment_at = ?, last_analysis_at = ?,
          source_mode = ?, source_duration_ms = ?, source_media_strategy = ?, analysis_audio_path = ?,
          temp_video_retention_ms = ?, last_capture_error_code = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(
    updated.status,
    updated.errorMessage,
    updated.captureCursorMs,
    updated.lastSegmentAt,
    updated.lastAnalysisAt,
    updated.sourceMode,
    updated.sourceDurationMs,
    updated.sourceMediaStrategy,
    updated.analysisAudioPath,
    updated.tempVideoRetentionMs,
    updated.lastCaptureErrorCode,
    updated.updatedAt,
    runId,
  );

  return getRun(runId);
}

export function setRunLabel(runId: string, label: string) {
  const db = getDb();
  const trimmed = label.trim();
  if (!trimmed) {
    return getRun(runId);
  }

  db.prepare(
    `
      UPDATE runs
      SET label = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(trimmed, new Date().toISOString(), runId);

  return getRun(runId);
}

export function setRunDriveFolder(runId: string, driveFolderId: string) {
  const db = getDb();
  db.prepare(
    `
      UPDATE runs
      SET drive_folder_id = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(driveFolderId, new Date().toISOString(), runId);

  return getRun(runId);
}

export function setRunAutoApprove(runId: string, autoApproveClips: boolean) {
  const db = getDb();
  db.prepare(
    `
      UPDATE runs
      SET auto_approve_clips = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(autoApproveClips ? 1 : 0, new Date().toISOString(), runId);

  return getRun(runId);
}

export function insertSegment(segment: {
  runId: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  videoPath: string;
  mediaType?: SegmentRecord["mediaType"];
  retentionStatus?: SegmentRecord["retentionStatus"];
  expiresAt?: string | null;
}) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare(
    "SELECT id FROM segments WHERE run_id = ? AND segment_index = ? ORDER BY datetime(created_at) DESC LIMIT 1",
  ).get(segment.runId, segment.segmentIndex) as { id: string } | undefined;

  const nextStatus = segment.videoPath ? "downloaded" : "downloading";
  const mediaType = segment.mediaType ?? "video";
  const retentionStatus = segment.retentionStatus ?? "retained";
  const expiresAt = segment.expiresAt ?? null;

  if (existing) {
    db.prepare(
      `
        UPDATE segments
        SET start_ms = ?, end_ms = ?, status = ?, video_path = ?, media_type = ?, retention_status = ?, expires_at = ?,
            transcript_path = NULL,
            error_message = NULL, created_at = ?, processed_at = NULL
        WHERE id = ?
      `,
    ).run(segment.startMs, segment.endMs, nextStatus, segment.videoPath, mediaType, retentionStatus, expiresAt, now, existing.id);

    return getSegment(existing.id);
  }

  const id = createId("segment");

  db.prepare(
    `
      INSERT INTO segments (
        id, run_id, segment_index, start_ms, end_ms, status, video_path, media_type, retention_status,
        expires_at, transcript_path, error_message, created_at, processed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)
    `,
  ).run(
    id,
    segment.runId,
    segment.segmentIndex,
    segment.startMs,
    segment.endMs,
    nextStatus,
    segment.videoPath,
    mediaType,
    retentionStatus,
    expiresAt,
    now,
  );

  return getSegment(id);
}

export function updateSegmentVideoPath(segmentId: string, videoPath: string) {
  const db = getDb();
  db.prepare(
    `
      UPDATE segments
      SET status = 'downloaded', video_path = ?, error_message = NULL
      WHERE id = ?
    `,
  ).run(videoPath, segmentId);

  return getSegment(segmentId);
}

export function markSegmentProcessed(
  segmentId: string,
  input: { transcriptPath: string; tokens: TranscriptToken[] },
) {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.exec("BEGIN");
    db.prepare(
      `
        UPDATE segments
        SET status = 'processed', transcript_path = ?, processed_at = ?
        WHERE id = ?
      `,
    ).run(input.transcriptPath, now, segmentId);

    db.prepare("DELETE FROM transcript_tokens WHERE segment_id = ?").run(segmentId);

    const insert = db.prepare(
      `
        INSERT INTO transcript_tokens (
          id, run_id, segment_id, text, start_ms, end_ms, confidence, token_kind, is_filler, is_removed, edit_source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    for (const token of input.tokens) {
      insert.run(
        token.id,
        token.runId,
        token.segmentId,
        token.text,
        token.startMs,
        token.endMs,
        token.confidence,
        token.tokenKind ?? "word",
        token.isFiller ? 1 : 0,
        token.isRemoved ? 1 : 0,
        token.editSource ?? "transcriber",
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getSegment(segmentId);
}

export function markSegmentFailed(segmentId: string, errorMessage: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `
      UPDATE segments
      SET status = 'error', error_message = ?, processed_at = ?
      WHERE id = ?
    `,
  ).run(errorMessage, now, segmentId);
}

export function getSegment(segmentId: string): SegmentRecord | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM segments WHERE id = ?").get(segmentId) as any;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    runId: row.run_id,
    segmentIndex: row.segment_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    status: row.status,
    videoPath: row.video_path,
    transcriptPath: row.transcript_path,
    errorMessage: row.error_message,
    mediaType: row.media_type ?? "video",
    retentionStatus: row.retention_status ?? "retained",
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

export function listSegments(runId: string) {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM segments WHERE run_id = ? ORDER BY segment_index ASC").all(runId) as any[];

  return canonicalizeSegments(rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    segmentIndex: row.segment_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    status: row.status,
    videoPath: row.video_path,
    transcriptPath: row.transcript_path,
    errorMessage: row.error_message,
    mediaType: row.media_type ?? "video",
    retentionStatus: row.retention_status ?? "retained",
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  })) satisfies SegmentRecord[]);
}

export function listRecentTokens(runId: string, afterMs: number) {
  const db = getDb();
  const rows = db
    .prepare(
      `
        SELECT * FROM transcript_tokens
        WHERE run_id = ? AND end_ms >= ?
        ORDER BY start_ms ASC
      `,
    )
    .all(runId, afterMs) as any[];

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    segmentId: row.segment_id,
    text: row.text,
    startMs: row.start_ms,
    endMs: row.end_ms,
    confidence: row.confidence,
    tokenKind: row.token_kind ?? "word",
    isFiller: Boolean(row.is_filler),
    isRemoved: Boolean(row.is_removed),
    editSource: row.edit_source ?? "transcriber",
  })) satisfies TranscriptToken[];
}

export function updateTranscriptTokenText(tokenId: string, text: string) {
  const db = getDb();
  const trimmed = text.trim();
  const isRemoved = trimmed.length === 0;

  db.prepare(
    `
      UPDATE transcript_tokens
      SET text = ?, edit_source = 'user', is_removed = ?
      WHERE id = ?
    `,
  ).run(isRemoved ? " " : trimmed, isRemoved ? 1 : 0, tokenId);

  const row = db.prepare("SELECT * FROM transcript_tokens WHERE id = ?").get(tokenId) as any;
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    runId: row.run_id,
    segmentId: row.segment_id,
    text: row.text,
    startMs: row.start_ms,
    endMs: row.end_ms,
    confidence: row.confidence,
    tokenKind: row.token_kind ?? "word",
    isFiller: Boolean(row.is_filler),
    isRemoved: Boolean(row.is_removed),
    editSource: row.edit_source ?? "user",
  } satisfies TranscriptToken;
}

export function getTranscriptWindow(runId: string): TranscriptWindow {
  const run = getRun(runId);
  if (!run) {
    return {
      runId,
      startedAtMs: 0,
      endedAtMs: 0,
      tokens: [],
    };
  }

  const windowStart = Math.max(0, run.captureCursorMs - ANALYSIS_WINDOW_MS);
  const tokens = listRecentTokens(runId, windowStart);

  return {
    runId,
    startedAtMs: windowStart,
    endedAtMs: run.captureCursorMs || SEGMENT_MS,
    tokens,
  };
}

export function listCandidatesForRun(runId: string) {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM candidates WHERE run_id = ? ORDER BY datetime(created_at) DESC")
    .all(runId) as CandidateRow[];
  return rows.map(mapCandidate);
}

export function createCandidate(runId: string, decision: AnalyzerDecision) {
  const db = getDb();
  const id = createId("candidate");
  const now = new Date().toISOString();

  db.prepare(
    `
      INSERT INTO candidates (
        id, run_id, suggested_start_ms, suggested_end_ms, confidence, reason, title, hook,
        keywords_json, render_config_json, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?)
    `,
  ).run(
    id,
    runId,
    decision.suggestedStart,
    decision.suggestedEnd,
    decision.confidence,
    decision.reason,
    decision.title,
    decision.hook,
    JSON.stringify(decision.keywords),
    now,
    now,
  );

  return getCandidate(id);
}

export function createApprovedCandidate(
  runId: string,
  decision: Omit<AnalyzerDecision, "worthClipping">,
) {
  const candidate = createCandidate(runId, {
    worthClipping: true,
    ...decision,
  });

  if (!candidate) {
    return null;
  }

  return setCandidateStatus(candidate.id, "approved");
}

export function getCandidate(candidateId: string) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM candidates WHERE id = ?").get(candidateId) as CandidateRow | undefined;
  return row ? mapCandidate(row) : null;
}

export function setCandidateStatus(candidateId: string, status: CandidateStatus) {
  const db = getDb();
  db.prepare(
    `
      UPDATE candidates
      SET status = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(status, new Date().toISOString(), candidateId);

  return getCandidate(candidateId);
}

export function setCandidateRenderConfig(candidateId: string, config: RenderConfig | null) {
  const db = getDb();
  db.prepare(
    `
      UPDATE candidates
      SET render_config_json = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(config ? JSON.stringify(config) : null, new Date().toISOString(), candidateId);

  return getCandidate(candidateId);
}

export function setCandidateCompaction(
  candidateId: string,
  input: Pick<ClipCandidate, "compactionStatus" | "compactionMode" | "compactStartMs" | "compactEndMs">,
) {
  const db = getDb();
  db.prepare(
    `
      UPDATE candidates
      SET compaction_status = ?, compaction_mode = ?, compact_start_ms = ?, compact_end_ms = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(
    input.compactionStatus,
    input.compactionMode,
    input.compactStartMs,
    input.compactEndMs,
    new Date().toISOString(),
    candidateId,
  );

  return getCandidate(candidateId);
}

export function updateCandidateCopy(
  candidateId: string,
  input: { title?: string; hook?: string },
) {
  const db = getDb();
  const existing = getCandidate(candidateId);

  if (!existing) {
    return null;
  }

  const nextTitle = input.title?.trim() || existing.title;
  const nextHook = input.hook?.trim() || existing.hook;

  db.prepare(
    `
      UPDATE candidates
      SET title = ?, hook = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(nextTitle, nextHook, new Date().toISOString(), candidateId);

  return getCandidate(candidateId);
}

export function listRenderTemplates() {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM render_templates ORDER BY datetime(updated_at) DESC, name COLLATE NOCASE ASC")
    .all() as TemplateRow[];
  return rows.map(mapTemplate);
}

export function getRenderTemplate(templateId: string) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM render_templates WHERE id = ?").get(templateId) as TemplateRow | undefined;
  return row ? mapTemplate(row) : null;
}

export function createRenderTemplate(input: {
  name: string;
  mode?: RenderTemplate["mode"];
  aiMotionEnabled?: boolean;
  motionIntensity?: RenderTemplate["motionIntensity"];
  allowPunchIns?: boolean;
  maxMotionEvents?: number;
  enableCaptions?: boolean;
  enableMotion?: boolean;
  enableColor?: boolean;
  enableMusic?: boolean;
  enableCompaction?: boolean;
  colorGradePreset?: RenderTemplate["colorGradePreset"];
  aiMusicEnabled?: boolean;
  introSrc: string | null;
  musicSrc: string | null;
  captionStyle: RenderTemplate["captionStyle"];
  captionSize: RenderTemplate["captionSize"];
  captionColor: string;
  captionPlacement: RenderTemplate["captionPlacement"];
  musicVolume: number;
  musicFadeIn: boolean;
  musicFadeOut: boolean;
  outroSrc: string | null;
  videoLayout: RenderTemplate["videoLayout"];
  videoFillMode: RenderTemplate["videoFillMode"];
  fontFamily?: string;
  fontSource?: RenderTemplate["fontSource"];
  subtitleMode?: RenderTemplate["subtitleMode"];
}) {
  const db = getDb();
  const id = createId("template");
  const now = new Date().toISOString();
  const mode = input.mode ?? "edited";

  db.prepare(
    `
      INSERT INTO render_templates (
        id, name, mode, ai_motion_enabled, motion_intensity, allow_punch_ins, max_motion_events,
        enable_captions, enable_motion, enable_color, enable_music, enable_compaction,
        color_grade_preset, ai_music_enabled,
        intro_src, music_src, caption_style, caption_size, caption_color, caption_placement,
        music_volume, music_fade_in, music_fade_out, outro_src, video_layout, video_fill_mode,
        font_family, font_source, subtitle_mode, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    input.name.trim(),
    mode,
    mode === "raw" ? 0 : input.aiMotionEnabled === false ? 0 : 1,
    mode === "raw" ? "none" : input.motionIntensity ?? "subtle",
    mode === "raw" ? 0 : input.allowPunchIns === false ? 0 : 1,
    mode === "raw" ? 0 : Math.max(0, Math.round(input.maxMotionEvents ?? 4)),
    mode === "raw" ? 0 : input.enableCaptions === false ? 0 : 1,
    mode === "raw" ? 0 : input.enableMotion === false ? 0 : 1,
    mode === "raw" ? 0 : input.enableColor === false ? 0 : 1,
    mode === "raw" ? 0 : input.enableMusic ? 1 : 0,
    mode === "raw" ? 0 : input.enableCompaction === false ? 0 : 1,
    input.colorGradePreset ?? "neutral",
    mode === "raw" ? 0 : input.aiMusicEnabled ? 1 : 0,
    input.introSrc,
    input.musicSrc,
    input.captionStyle,
    input.captionSize,
    input.captionColor,
    input.captionPlacement,
    Math.max(0, Math.min(100, Math.round(input.musicVolume))),
    input.musicFadeIn ? 1 : 0,
    input.musicFadeOut ? 1 : 0,
    input.outroSrc,
    input.videoLayout,
    input.videoFillMode,
    input.fontFamily?.trim() || DEFAULT_TEMPLATE_FONT_FAMILY,
    input.fontSource ?? (DEFAULT_TEMPLATE_FONT_SOURCE as RenderTemplate["fontSource"]),
    input.subtitleMode ?? (SUBTITLE_MODE as RenderTemplate["subtitleMode"]),
    now,
    now,
  );

  return getRenderTemplate(id);
}

export function updateRenderTemplate(
  templateId: string,
  input: {
    name: string;
    mode?: RenderTemplate["mode"];
    aiMotionEnabled?: boolean;
    motionIntensity?: RenderTemplate["motionIntensity"];
    allowPunchIns?: boolean;
    maxMotionEvents?: number;
    enableCaptions?: boolean;
    enableMotion?: boolean;
    enableColor?: boolean;
    enableMusic?: boolean;
    enableCompaction?: boolean;
    colorGradePreset?: RenderTemplate["colorGradePreset"];
    aiMusicEnabled?: boolean;
    introSrc: string | null;
    musicSrc: string | null;
    captionStyle: RenderTemplate["captionStyle"];
    captionSize: RenderTemplate["captionSize"];
    captionColor: string;
    captionPlacement: RenderTemplate["captionPlacement"];
    musicVolume: number;
    musicFadeIn: boolean;
    musicFadeOut: boolean;
    outroSrc: string | null;
    videoLayout: RenderTemplate["videoLayout"];
    videoFillMode: RenderTemplate["videoFillMode"];
    fontFamily?: string;
    fontSource?: RenderTemplate["fontSource"];
    subtitleMode?: RenderTemplate["subtitleMode"];
  },
) {
  const db = getDb();
  const mode = input.mode ?? "edited";
  db.prepare(
    `
      UPDATE render_templates
      SET name = ?, mode = ?, ai_motion_enabled = ?, motion_intensity = ?, allow_punch_ins = ?,
          max_motion_events = ?, enable_captions = ?, enable_motion = ?, enable_color = ?,
          enable_music = ?, enable_compaction = ?, color_grade_preset = ?, ai_music_enabled = ?,
          intro_src = ?, music_src = ?, caption_style = ?, caption_size = ?, caption_color = ?, caption_placement = ?,
          music_volume = ?, music_fade_in = ?, music_fade_out = ?, outro_src = ?, video_layout = ?, video_fill_mode = ?,
          font_family = ?, font_source = ?, subtitle_mode = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(
    input.name.trim(),
    mode,
    mode === "raw" ? 0 : input.aiMotionEnabled === false ? 0 : 1,
    mode === "raw" ? "none" : input.motionIntensity ?? "subtle",
    mode === "raw" ? 0 : input.allowPunchIns === false ? 0 : 1,
    mode === "raw" ? 0 : Math.max(0, Math.round(input.maxMotionEvents ?? 4)),
    mode === "raw" ? 0 : input.enableCaptions === false ? 0 : 1,
    mode === "raw" ? 0 : input.enableMotion === false ? 0 : 1,
    mode === "raw" ? 0 : input.enableColor === false ? 0 : 1,
    mode === "raw" ? 0 : input.enableMusic ? 1 : 0,
    mode === "raw" ? 0 : input.enableCompaction === false ? 0 : 1,
    input.colorGradePreset ?? "neutral",
    mode === "raw" ? 0 : input.aiMusicEnabled ? 1 : 0,
    input.introSrc,
    input.musicSrc,
    input.captionStyle,
    input.captionSize,
    input.captionColor,
    input.captionPlacement,
    Math.max(0, Math.min(100, Math.round(input.musicVolume))),
    input.musicFadeIn ? 1 : 0,
    input.musicFadeOut ? 1 : 0,
    input.outroSrc,
    input.videoLayout,
    input.videoFillMode,
    input.fontFamily?.trim() || DEFAULT_TEMPLATE_FONT_FAMILY,
    input.fontSource ?? (DEFAULT_TEMPLATE_FONT_SOURCE as RenderTemplate["fontSource"]),
    input.subtitleMode ?? (SUBTITLE_MODE as RenderTemplate["subtitleMode"]),
    new Date().toISOString(),
    templateId,
  );

  return getRenderTemplate(templateId);
}

export function deleteRenderTemplate(templateId: string) {
  const db = getDb();
  db.prepare("DELETE FROM render_templates WHERE id = ?").run(templateId);
}

export function listApprovedMediaRanges(candidateId: string) {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM approved_media_ranges WHERE candidate_id = ? ORDER BY source_start_ms ASC",
  ).all(candidateId) as any[];

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    candidateId: row.candidate_id,
    sourceStartMs: row.source_start_ms,
    sourceEndMs: row.source_end_ms,
    videoPath: row.video_path,
    mediaOrigin: row.media_origin,
    createdAt: row.created_at,
  }));
}

export function upsertApprovedMediaRange(input: {
  runId: string;
  candidateId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  videoPath: string;
  mediaOrigin: "vod_range_download" | "live_cache_copy" | "manual_upload";
}) {
  const db = getDb();
  const existing = db.prepare(
    `
      SELECT id FROM approved_media_ranges
      WHERE candidate_id = ? AND source_start_ms = ? AND source_end_ms = ? AND video_path = ?
      LIMIT 1
    `,
  ).get(input.candidateId, input.sourceStartMs, input.sourceEndMs, input.videoPath) as { id: string } | undefined;

  if (existing) {
    return listApprovedMediaRanges(input.candidateId).find((range) => range.id === existing.id) ?? null;
  }

  const id = createId("media");
  db.prepare(
    `
      INSERT INTO approved_media_ranges (
        id, run_id, candidate_id, source_start_ms, source_end_ms, video_path, media_origin, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    input.runId,
    input.candidateId,
    input.sourceStartMs,
    input.sourceEndMs,
    input.videoPath,
    input.mediaOrigin,
    new Date().toISOString(),
  );

  return listApprovedMediaRanges(input.candidateId).find((range) => range.id === id) ?? null;
}

export function replaceClipSpans(candidateId: string, spans: Array<{
  runId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  outputStartMs: number;
  outputEndMs: number;
  reason?: string | null;
}>) {
  const db = getDb();
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM clip_spans WHERE candidate_id = ?").run(candidateId);
    const insert = db.prepare(
      `
        INSERT INTO clip_spans (
          id, candidate_id, run_id, source_start_ms, source_end_ms, output_start_ms, output_end_ms, reason, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    for (const span of spans) {
      insert.run(
        createId("span"),
        candidateId,
        span.runId,
        span.sourceStartMs,
        span.sourceEndMs,
        span.outputStartMs,
        span.outputEndMs,
        span.reason ?? null,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return listClipSpans(candidateId);
}

export function listClipSpans(candidateId: string) {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM clip_spans WHERE candidate_id = ? ORDER BY output_start_ms ASC",
  ).all(candidateId) as any[];

  return rows.map((row) => ({
    id: row.id,
    candidateId: row.candidate_id,
    runId: row.run_id,
    sourceStartMs: row.source_start_ms,
    sourceEndMs: row.source_end_ms,
    outputStartMs: row.output_start_ms,
    outputEndMs: row.output_end_ms,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

export function getLatestEditDirectionPlan(candidateId: string) {
  const db = getDb();
  const row = db.prepare(
    `
      SELECT * FROM edit_direction_plans
      WHERE candidate_id = ? AND status = 'ready'
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `,
  ).get(candidateId) as
    | {
        id: string;
        run_id: string;
        candidate_id: string;
        plan_json: string;
        prompt_version: string | null;
        schema_version: string | null;
        plan_signature: string;
        status: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    runId: row.run_id,
    candidateId: row.candidate_id,
    plan: safeJsonParse<EditDirectionPlan | null>(row.plan_json, null),
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    planSignature: row.plan_signature,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertEditDirectionPlan(input: {
  runId: string;
  candidateId: string;
  plan: EditDirectionPlan;
  promptVersion: string;
  schemaVersion: string;
}) {
  const db = getDb();
  const planJson = JSON.stringify(input.plan);
  const planSignature = createStableHash(planJson);
  const existing = db.prepare(
    `
      SELECT id FROM edit_direction_plans
      WHERE candidate_id = ? AND plan_signature = ? AND status = 'ready'
      LIMIT 1
    `,
  ).get(input.candidateId, planSignature) as { id: string } | undefined;
  if (existing) {
    return getLatestEditDirectionPlan(input.candidateId);
  }

  const id = createId("direction");
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO edit_direction_plans (
        id, run_id, candidate_id, plan_json, prompt_version, schema_version,
        plan_signature, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
    `,
  ).run(
    id,
    input.runId,
    input.candidateId,
    planJson,
    input.promptVersion,
    input.schemaVersion,
    planSignature,
    now,
    now,
  );

  return getLatestEditDirectionPlan(input.candidateId);
}

export function isRuntimeAssetReferenced(publicSrc: string) {
  const db = getDb();
  const templateReference = db
    .prepare(
      `
        SELECT 1 FROM render_templates
        WHERE intro_src = ? OR music_src = ? OR outro_src = ?
        LIMIT 1
      `,
    )
    .get(publicSrc, publicSrc, publicSrc);

  if (templateReference) {
    return true;
  }

  const candidateRows = db
    .prepare("SELECT render_config_json FROM candidates WHERE render_config_json IS NOT NULL")
    .all() as Array<{ render_config_json: string }>;

  return candidateRows.some((row) => {
    const config = safeJsonParse<RenderConfig | null>(row.render_config_json, null);
    return config?.introSrc === publicSrc || config?.musicSrc === publicSrc || config?.outroSrc === publicSrc;
  });
}

export function updateCandidateWindow(
  candidateId: string,
  input: { suggestedStartMs?: number; suggestedEndMs?: number },
) {
  const db = getDb();
  const existing = getCandidate(candidateId);

  if (!existing) {
    return null;
  }

  const nextStartMs = input.suggestedStartMs ?? existing.suggestedStartMs;
  const nextEndMs = input.suggestedEndMs ?? existing.suggestedEndMs;

  if (!Number.isFinite(nextStartMs) || !Number.isFinite(nextEndMs) || nextEndMs <= nextStartMs) {
    return null;
  }

  db.prepare(
    `
      UPDATE candidates
      SET suggested_start_ms = ?, suggested_end_ms = ?, compaction_status = 'pending',
          compact_start_ms = NULL, compact_end_ms = NULL, updated_at = ?
      WHERE id = ?
    `,
  ).run(nextStartMs, nextEndMs, new Date().toISOString(), candidateId);

  return getCandidate(candidateId);
}

export function createRenderJob(input: {
  runId: string;
  candidateId: string;
  format: RenderFormat;
  renderConfig: RenderConfig | null;
  sourceStrategy?: RenderJob["sourceStrategy"];
  clipSpansJson?: string | null;
  signatureSalt?: string | null;
}) {
  const db = getDb();
  const candidate = getCandidate(input.candidateId);
  if (!candidate) {
    return null;
  }

  const signature = createStableHash(JSON.stringify({
    version: RENDER_SIGNATURE_VERSION,
    startMs: candidate.suggestedStartMs,
    endMs: candidate.suggestedEndMs,
    title: candidate.title,
    hook: candidate.hook,
    format: input.format,
    renderConfig: input.renderConfig,
    sourceStrategy: input.sourceStrategy ?? "continuous",
    clipSpansJson: input.clipSpansJson ?? null,
    signatureSalt: input.signatureSalt ?? null,
    rendererVersion: RENDERER_VERSION,
  }));
  const existing = db
    .prepare(
      `
        SELECT * FROM render_jobs
        WHERE run_id = ? AND candidate_id = ? AND format = ? AND render_signature = ?
        ORDER BY datetime(created_at) DESC
        LIMIT 1
      `,
    )
    .get(input.runId, input.candidateId, input.format, signature) as RenderRow | undefined;

  if (existing && existing.output_path) {
    return mapRender(existing);
  }

  if (existing && existing.status !== "error") {
    return mapRender(existing);
  }

  const id = createId("render");
  const now = new Date().toISOString();

  db.prepare(
    `
      INSERT INTO render_jobs (
        id, run_id, candidate_id, format, render_config_json, render_signature, renderer_version, status, progress_percent,
        source_strategy, clip_spans_json, output_path, error_message, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, ?, ?)
    `,
  ).run(
    id,
    input.runId,
    input.candidateId,
    input.format,
    input.renderConfig ? JSON.stringify(input.renderConfig) : null,
    signature,
    RENDERER_VERSION,
    input.sourceStrategy ?? "continuous",
    input.clipSpansJson ?? null,
    now,
    now,
  );

  return getRenderJob(id);
}

export function listRenderJobsForRun(runId: string) {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM render_jobs WHERE run_id = ? ORDER BY datetime(created_at) DESC")
    .all(runId) as RenderRow[];
  return cleanRenderHistory(rows.map(mapRender));
}

export function listPendingRenderJobs() {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM render_jobs WHERE status IN ('pending', 'rendering') ORDER BY datetime(created_at) ASC",
    )
    .all() as RenderRow[];
  return rows.map(mapRender);
}

export function getRenderJob(renderId: string) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(renderId) as RenderRow | undefined;
  return row ? mapRender(row) : null;
}

export function markRenderJob(
  renderId: string,
  updates: Partial<
    Pick<
      RenderJob,
      | "status"
      | "progressPercent"
      | "outputPath"
      | "driveFileId"
      | "driveFolderId"
      | "driveWebViewLink"
      | "driveUploadStatus"
      | "driveErrorMessage"
      | "telegramNotifiedAt"
      | "errorMessage"
      | "captionTimingOffsetMs"
    >
  >,
) {
  const db = getDb();
  const existing = getRenderJob(renderId);
  if (!existing) {
    return null;
  }

  const merged = {
    status: updates.status ?? existing.status,
    progressPercent: updates.progressPercent === undefined ? existing.progressPercent : updates.progressPercent,
    outputPath: updates.outputPath === undefined ? existing.outputPath : updates.outputPath,
    driveFileId: updates.driveFileId === undefined ? existing.driveFileId : updates.driveFileId,
    driveFolderId: updates.driveFolderId === undefined ? existing.driveFolderId : updates.driveFolderId,
    driveWebViewLink: updates.driveWebViewLink === undefined ? existing.driveWebViewLink : updates.driveWebViewLink,
    driveUploadStatus:
      updates.driveUploadStatus === undefined ? existing.driveUploadStatus : updates.driveUploadStatus,
    driveErrorMessage:
      updates.driveErrorMessage === undefined ? existing.driveErrorMessage : updates.driveErrorMessage,
    telegramNotifiedAt:
      updates.telegramNotifiedAt === undefined ? existing.telegramNotifiedAt : updates.telegramNotifiedAt,
    errorMessage: updates.errorMessage === undefined ? existing.errorMessage : updates.errorMessage,
    captionTimingOffsetMs:
      updates.captionTimingOffsetMs === undefined ? existing.captionTimingOffsetMs : updates.captionTimingOffsetMs,
    updatedAt: new Date().toISOString(),
  };

  if (merged.status === "rendered") {
    merged.progressPercent = null;
    merged.errorMessage = null;
  }

  db.prepare(
    `
      UPDATE render_jobs
      SET status = ?, progress_percent = ?, output_path = ?, drive_file_id = ?, drive_folder_id = ?,
          drive_web_view_link = ?, drive_upload_status = ?, drive_error_message = ?,
          telegram_notified_at = ?, error_message = ?, caption_timing_offset_ms = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(
    merged.status,
    merged.progressPercent,
    merged.outputPath,
    merged.driveFileId,
    merged.driveFolderId,
    merged.driveWebViewLink,
    merged.driveUploadStatus,
    merged.driveErrorMessage,
    merged.telegramNotifiedAt,
    merged.errorMessage,
    merged.captionTimingOffsetMs,
    merged.updatedAt,
    renderId,
  );

  return getRenderJob(renderId);
}

export function markRenderTelegramNotified(renderId: string) {
  return markRenderJob(renderId, {
    telegramNotifiedAt: new Date().toISOString(),
  });
}

export function listTelegramNotificationReadyExports() {
  const db = getDb();
  const rows = db
    .prepare(
      `
        SELECT render_jobs.*, candidates.title, candidates.hook
        FROM render_jobs
        INNER JOIN candidates ON candidates.id = render_jobs.candidate_id
        WHERE render_jobs.status = 'rendered'
          AND render_jobs.drive_upload_status = 'uploaded'
          AND render_jobs.drive_web_view_link IS NOT NULL
          AND render_jobs.telegram_notified_at IS NULL
        ORDER BY datetime(render_jobs.updated_at) ASC
      `,
    )
    .all() as any[];

  return rows.map((row) => ({
    ...mapRender(row),
    title: row.title as string,
    hook: row.hook as string,
    fileName: row.output_path ? path.basename(row.output_path) : null,
  }));
}

export function listPendingDriveUploads(limit: number) {
  const db = getDb();
  const rows = db
    .prepare(
      `
        SELECT * FROM render_jobs
        WHERE status = 'rendered'
          AND output_path IS NOT NULL
          AND drive_upload_status = 'pending'
        ORDER BY datetime(updated_at) ASC
        LIMIT ?
      `,
    )
    .all(limit) as RenderRow[];

  return rows.map(mapRender);
}

export function listExports() {
  const db = getDb();
  const rows = db
    .prepare(
      `
        SELECT render_jobs.*, candidates.title, candidates.hook
        FROM render_jobs
        INNER JOIN candidates ON candidates.id = render_jobs.candidate_id
        WHERE render_jobs.output_path IS NOT NULL
        ORDER BY datetime(render_jobs.updated_at) DESC
      `,
    )
    .all() as any[];

  return cleanRenderHistory(rows.map((row) => ({
    ...mapRender(row),
    title: row.title,
    hook: row.hook,
    fileName: row.output_path ? path.basename(row.output_path) : null,
  })));
}

export function listExportsForRun(runId: string) {
  return listExports().filter((item) => item.runId === runId);
}

export function listSubtitleCues(renderId: string) {
  ensureSubtitleCueTable();
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM subtitle_cues WHERE render_id = ? ORDER BY cue_index ASC")
    .all(renderId) as SubtitleCueRow[];

  return rows.map(mapSubtitleCue);
}

export function replaceSubtitleCues(
  renderId: string,
  cues: Array<{
    candidateId: string;
    runId: string;
    text: string;
    startMs: number;
    endMs: number;
    isHidden?: boolean;
    sourceTokenIds?: string[];
    editSource?: SubtitleCue["editSource"];
  }>,
) {
  ensureSubtitleCueTable();
  const db = getDb();
  const now = new Date().toISOString();

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM subtitle_cues WHERE render_id = ?").run(renderId);
    const insert = db.prepare(
      `
        INSERT INTO subtitle_cues (
          id, render_id, candidate_id, run_id, cue_index, text, start_ms, end_ms,
          is_hidden, source_token_ids_json, edit_source, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    cues.forEach((cue, index) => {
      insert.run(
        createId("cue"),
        renderId,
        cue.candidateId,
        cue.runId,
        index,
        cue.text,
        cue.startMs,
        cue.endMs,
        cue.isHidden ? 1 : 0,
        JSON.stringify(cue.sourceTokenIds ?? []),
        cue.editSource ?? "generated",
        now,
        now,
      );
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return listSubtitleCues(renderId);
}

export function copySubtitleCues(sourceRenderId: string, targetRenderId: string) {
  const targetRender = getRenderJob(targetRenderId);
  if (!targetRender) {
    return [];
  }

  return replaceSubtitleCues(
    targetRenderId,
    listSubtitleCues(sourceRenderId).map((cue) => ({
      candidateId: targetRender.candidateId,
      runId: targetRender.runId,
      text: cue.text,
      startMs: cue.startMs,
      endMs: cue.endMs,
      isHidden: cue.isHidden,
      sourceTokenIds: cue.sourceTokenIds,
      editSource: cue.editSource,
    })),
  );
}

export function listActiveRuns() {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM runs WHERE status = 'active' ORDER BY datetime(created_at) ASC")
    .all() as RunRow[];
  return rows.map(mapRun);
}

export function stopRun(runId: string) {
  return markRun(runId, {
    status: "stopped",
    errorMessage: null,
  });
}

export function resetStaleRenderingJobs(beforeIso: string) {
  const db = getDb();
  db.prepare(
    `
      UPDATE render_jobs
      SET status = 'pending', progress_percent = 0, updated_at = ?, error_message = COALESCE(error_message, 'Render job was reset after getting stuck.')
      WHERE status = 'rendering' AND output_path IS NULL AND datetime(updated_at) < datetime(?)
    `,
  ).run(new Date().toISOString(), beforeIso);
}

export function resetStaleDriveUploads(beforeIso: string) {
  const db = getDb();
  db.prepare(
    `
      UPDATE render_jobs
      SET drive_upload_status = 'pending', drive_error_message = NULL, updated_at = ?
      WHERE drive_upload_status = 'uploading' AND datetime(updated_at) < datetime(?)
    `,
  ).run(new Date().toISOString(), beforeIso);
}
