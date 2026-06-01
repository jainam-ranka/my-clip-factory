import { DatabaseSync } from "node:sqlite";
import { DATABASE_PATH } from "@/lib/config";
import { ensureBaseDirectories } from "./fs";

declare global {
  // eslint-disable-next-line no-var
  var __clipFactoryDb: DatabaseSync | undefined;
}

function createDatabase() {
  ensureBaseDirectories();

  const db = new DatabaseSync(DATABASE_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      source_url TEXT NOT NULL,
      platform TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      storage_dir TEXT NOT NULL,
      capture_cursor_ms INTEGER NOT NULL DEFAULT 0,
      last_segment_at TEXT,
      last_analysis_at TEXT,
      drive_folder_id TEXT,
      auto_approve_clips INTEGER NOT NULL DEFAULT 0,
      source_mode TEXT NOT NULL DEFAULT 'unknown',
      source_duration_ms INTEGER,
      source_media_strategy TEXT NOT NULL DEFAULT 'legacy_segment_video',
      analysis_audio_path TEXT,
      temp_video_retention_ms INTEGER,
      last_capture_error_code TEXT
    );

    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      video_path TEXT NOT NULL,
      transcript_path TEXT,
      error_message TEXT,
      media_type TEXT NOT NULL DEFAULT 'video',
      retention_status TEXT NOT NULL DEFAULT 'retained',
      expires_at TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transcript_tokens (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      text TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      confidence REAL,
      token_kind TEXT NOT NULL DEFAULT 'word',
      is_filler INTEGER NOT NULL DEFAULT 0,
      is_removed INTEGER NOT NULL DEFAULT 0,
      edit_source TEXT NOT NULL DEFAULT 'transcriber',
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY (segment_id) REFERENCES segments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      suggested_start_ms INTEGER NOT NULL,
      suggested_end_ms INTEGER NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT NOT NULL,
      title TEXT NOT NULL,
      hook TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      render_config_json TEXT,
      compaction_status TEXT NOT NULL DEFAULT 'pending',
      compaction_mode TEXT,
      compact_start_ms INTEGER,
      compact_end_ms INTEGER,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS render_jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      format TEXT NOT NULL,
      status TEXT NOT NULL,
      renderer_version TEXT,
      output_path TEXT,
      drive_file_id TEXT,
      drive_folder_id TEXT,
      drive_web_view_link TEXT,
      drive_upload_status TEXT NOT NULL DEFAULT 'not_configured',
      drive_error_message TEXT,
      telegram_notified_at TEXT,
      render_config_json TEXT,
      render_signature TEXT,
      progress_percent REAL,
      caption_timing_offset_ms INTEGER,
      source_strategy TEXT NOT NULL DEFAULT 'continuous',
      clip_spans_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS render_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'edited',
      ai_motion_enabled INTEGER NOT NULL DEFAULT 1,
      motion_intensity TEXT NOT NULL DEFAULT 'subtle',
      allow_punch_ins INTEGER NOT NULL DEFAULT 1,
      max_motion_events INTEGER NOT NULL DEFAULT 4,
      enable_captions INTEGER NOT NULL DEFAULT 1,
      enable_motion INTEGER NOT NULL DEFAULT 1,
      enable_color INTEGER NOT NULL DEFAULT 1,
      enable_music INTEGER NOT NULL DEFAULT 0,
      enable_compaction INTEGER NOT NULL DEFAULT 1,
      color_grade_preset TEXT NOT NULL DEFAULT 'neutral',
      ai_music_enabled INTEGER NOT NULL DEFAULT 0,
      intro_src TEXT,
      music_src TEXT,
      caption_style TEXT NOT NULL,
      caption_size TEXT NOT NULL,
      caption_color TEXT NOT NULL,
      caption_placement TEXT NOT NULL,
      music_volume INTEGER NOT NULL,
      music_fade_in INTEGER NOT NULL DEFAULT 1,
      music_fade_out INTEGER NOT NULL DEFAULT 1,
      outro_src TEXT,
      video_layout TEXT NOT NULL,
      video_fill_mode TEXT NOT NULL DEFAULT 'blur',
      font_family TEXT NOT NULL DEFAULT 'Archivo',
      font_source TEXT NOT NULL DEFAULT 'google',
      subtitle_mode TEXT NOT NULL DEFAULT 'one_word',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clip_spans (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      source_start_ms INTEGER NOT NULL,
      source_end_ms INTEGER NOT NULL,
      output_start_ms INTEGER NOT NULL,
      output_end_ms INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS approved_media_ranges (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      source_start_ms INTEGER NOT NULL,
      source_end_ms INTEGER NOT NULL,
      video_path TEXT NOT NULL,
      media_origin TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS edit_direction_plans (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      prompt_version TEXT,
      schema_version TEXT,
      plan_signature TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );

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

    CREATE INDEX IF NOT EXISTS idx_segments_run ON segments(run_id, segment_index);
    CREATE INDEX IF NOT EXISTS idx_tokens_run ON transcript_tokens(run_id, start_ms);
    CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_renders_run ON render_jobs(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_templates_updated ON render_templates(updated_at);
    CREATE INDEX IF NOT EXISTS idx_clip_spans_candidate ON clip_spans(candidate_id, output_start_ms);
    CREATE INDEX IF NOT EXISTS idx_clip_spans_run ON clip_spans(run_id, source_start_ms);
    CREATE INDEX IF NOT EXISTS idx_approved_media_candidate ON approved_media_ranges(candidate_id, source_start_ms);
    CREATE INDEX IF NOT EXISTS idx_approved_media_run ON approved_media_ranges(run_id, source_start_ms);
    CREATE INDEX IF NOT EXISTS idx_edit_direction_candidate ON edit_direction_plans(candidate_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_subtitle_cues_render ON subtitle_cues(render_id, cue_index);
    CREATE INDEX IF NOT EXISTS idx_subtitle_cues_candidate ON subtitle_cues(candidate_id, cue_index);
  `);

  const candidateColumns = db.prepare("PRAGMA table_info(candidates)").all() as Array<{ name: string }>;
  if (!candidateColumns.some((column) => column.name === "render_config_json")) {
    db.exec("ALTER TABLE candidates ADD COLUMN render_config_json TEXT;");
  }
  for (const [name, sql] of [
    ["compaction_status", "ALTER TABLE candidates ADD COLUMN compaction_status TEXT NOT NULL DEFAULT 'pending';"],
    ["compaction_mode", "ALTER TABLE candidates ADD COLUMN compaction_mode TEXT;"],
    ["compact_start_ms", "ALTER TABLE candidates ADD COLUMN compact_start_ms INTEGER;"],
    ["compact_end_ms", "ALTER TABLE candidates ADD COLUMN compact_end_ms INTEGER;"],
  ] as const) {
    if (!candidateColumns.some((column) => column.name === name)) {
      db.exec(sql);
    }
  }

  const runColumns = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "drive_folder_id")) {
    db.exec("ALTER TABLE runs ADD COLUMN drive_folder_id TEXT;");
  }
  if (!runColumns.some((column) => column.name === "auto_approve_clips")) {
    db.exec("ALTER TABLE runs ADD COLUMN auto_approve_clips INTEGER NOT NULL DEFAULT 0;");
  }
  for (const [name, sql] of [
    ["source_mode", "ALTER TABLE runs ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'unknown';"],
    ["source_duration_ms", "ALTER TABLE runs ADD COLUMN source_duration_ms INTEGER;"],
    ["source_media_strategy", "ALTER TABLE runs ADD COLUMN source_media_strategy TEXT NOT NULL DEFAULT 'legacy_segment_video';"],
    ["analysis_audio_path", "ALTER TABLE runs ADD COLUMN analysis_audio_path TEXT;"],
    ["temp_video_retention_ms", "ALTER TABLE runs ADD COLUMN temp_video_retention_ms INTEGER;"],
    ["last_capture_error_code", "ALTER TABLE runs ADD COLUMN last_capture_error_code TEXT;"],
  ] as const) {
    if (!runColumns.some((column) => column.name === name)) {
      db.exec(sql);
    }
  }

  const segmentColumns = db.prepare("PRAGMA table_info(segments)").all() as Array<{ name: string }>;
  for (const [name, sql] of [
    ["media_type", "ALTER TABLE segments ADD COLUMN media_type TEXT NOT NULL DEFAULT 'video';"],
    ["retention_status", "ALTER TABLE segments ADD COLUMN retention_status TEXT NOT NULL DEFAULT 'retained';"],
    ["expires_at", "ALTER TABLE segments ADD COLUMN expires_at TEXT;"],
  ] as const) {
    if (!segmentColumns.some((column) => column.name === name)) {
      db.exec(sql);
    }
  }

  const tokenColumns = db.prepare("PRAGMA table_info(transcript_tokens)").all() as Array<{ name: string }>;
  for (const [name, sql] of [
    ["token_kind", "ALTER TABLE transcript_tokens ADD COLUMN token_kind TEXT NOT NULL DEFAULT 'word';"],
    ["is_filler", "ALTER TABLE transcript_tokens ADD COLUMN is_filler INTEGER NOT NULL DEFAULT 0;"],
    ["is_removed", "ALTER TABLE transcript_tokens ADD COLUMN is_removed INTEGER NOT NULL DEFAULT 0;"],
    ["edit_source", "ALTER TABLE transcript_tokens ADD COLUMN edit_source TEXT NOT NULL DEFAULT 'transcriber';"],
  ] as const) {
    if (!tokenColumns.some((column) => column.name === name)) {
      db.exec(sql);
    }
  }

  const renderColumns = db.prepare("PRAGMA table_info(render_jobs)").all() as Array<{ name: string }>;
  if (!renderColumns.some((column) => column.name === "render_config_json")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN render_config_json TEXT;");
  }
  if (!renderColumns.some((column) => column.name === "render_signature")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN render_signature TEXT;");
  }
  if (!renderColumns.some((column) => column.name === "renderer_version")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN renderer_version TEXT;");
  }
  if (!renderColumns.some((column) => column.name === "progress_percent")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN progress_percent REAL;");
  }
  if (!renderColumns.some((column) => column.name === "caption_timing_offset_ms")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN caption_timing_offset_ms INTEGER;");
  }
  if (!renderColumns.some((column) => column.name === "drive_file_id")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN drive_file_id TEXT;");
  }
  if (!renderColumns.some((column) => column.name === "drive_folder_id")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN drive_folder_id TEXT;");
  }
  if (!renderColumns.some((column) => column.name === "drive_web_view_link")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN drive_web_view_link TEXT;");
  }
  if (!renderColumns.some((column) => column.name === "drive_upload_status")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN drive_upload_status TEXT NOT NULL DEFAULT 'not_configured';");
  }
  if (!renderColumns.some((column) => column.name === "drive_error_message")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN drive_error_message TEXT;");
  }
  if (!renderColumns.some((column) => column.name === "telegram_notified_at")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN telegram_notified_at TEXT;");
  }
  if (!renderColumns.some((column) => column.name === "source_strategy")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN source_strategy TEXT NOT NULL DEFAULT 'continuous';");
  }
  if (!renderColumns.some((column) => column.name === "clip_spans_json")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN clip_spans_json TEXT;");
  }

  const templateColumns = db.prepare("PRAGMA table_info(render_templates)").all() as Array<{ name: string }>;
  for (const [name, sql] of [
    ["mode", "ALTER TABLE render_templates ADD COLUMN mode TEXT NOT NULL DEFAULT 'edited';"],
    ["ai_motion_enabled", "ALTER TABLE render_templates ADD COLUMN ai_motion_enabled INTEGER NOT NULL DEFAULT 1;"],
    ["motion_intensity", "ALTER TABLE render_templates ADD COLUMN motion_intensity TEXT NOT NULL DEFAULT 'subtle';"],
    ["allow_punch_ins", "ALTER TABLE render_templates ADD COLUMN allow_punch_ins INTEGER NOT NULL DEFAULT 1;"],
    ["max_motion_events", "ALTER TABLE render_templates ADD COLUMN max_motion_events INTEGER NOT NULL DEFAULT 4;"],
    ["enable_captions", "ALTER TABLE render_templates ADD COLUMN enable_captions INTEGER NOT NULL DEFAULT 1;"],
    ["enable_motion", "ALTER TABLE render_templates ADD COLUMN enable_motion INTEGER NOT NULL DEFAULT 1;"],
    ["enable_color", "ALTER TABLE render_templates ADD COLUMN enable_color INTEGER NOT NULL DEFAULT 1;"],
    ["enable_music", "ALTER TABLE render_templates ADD COLUMN enable_music INTEGER NOT NULL DEFAULT 0;"],
    ["enable_compaction", "ALTER TABLE render_templates ADD COLUMN enable_compaction INTEGER NOT NULL DEFAULT 1;"],
    ["color_grade_preset", "ALTER TABLE render_templates ADD COLUMN color_grade_preset TEXT NOT NULL DEFAULT 'neutral';"],
    ["ai_music_enabled", "ALTER TABLE render_templates ADD COLUMN ai_music_enabled INTEGER NOT NULL DEFAULT 0;"],
  ] as const) {
    if (!templateColumns.some((column) => column.name === name)) {
      db.exec(sql);
    }
  }
  if (!templateColumns.some((column) => column.name === "intro_src")) {
    db.exec("ALTER TABLE render_templates ADD COLUMN intro_src TEXT;");
  }
  if (!templateColumns.some((column) => column.name === "music_src")) {
    db.exec("ALTER TABLE render_templates ADD COLUMN music_src TEXT;");
  }
  if (!templateColumns.some((column) => column.name === "video_fill_mode")) {
    db.exec("ALTER TABLE render_templates ADD COLUMN video_fill_mode TEXT;");
  }
  if (!templateColumns.some((column) => column.name === "font_family")) {
    db.exec("ALTER TABLE render_templates ADD COLUMN font_family TEXT NOT NULL DEFAULT 'Archivo';");
  }
  if (!templateColumns.some((column) => column.name === "font_source")) {
    db.exec("ALTER TABLE render_templates ADD COLUMN font_source TEXT NOT NULL DEFAULT 'google';");
  }
  if (!templateColumns.some((column) => column.name === "subtitle_mode")) {
    db.exec("ALTER TABLE render_templates ADD COLUMN subtitle_mode TEXT NOT NULL DEFAULT 'one_word';");
  }
  db.exec("UPDATE render_templates SET video_fill_mode = 'blur' WHERE video_fill_mode IS NULL OR TRIM(video_fill_mode) = '';");

  return db;
}

export function getDb() {
  if (!globalThis.__clipFactoryDb) {
    globalThis.__clipFactoryDb = createDatabase();
  }

  return globalThis.__clipFactoryDb;
}
