import path from "node:path";

export const APP_ROOT = process.cwd();
export const DATA_DIR = path.join(APP_ROOT, "data");
export const STORAGE_DIR = path.join(APP_ROOT, "storage");
export const PUBLIC_RUNTIME_DIR = path.join(APP_ROOT, "public", "runtime");
export const RUNTIME_ASSETS_DIR = path.join(PUBLIC_RUNTIME_DIR, "assets");
export const RUNTIME_CLIPS_DIR = path.join(PUBLIC_RUNTIME_DIR, "clips");
export const RUNTIME_EXPORTS_DIR = path.join(APP_ROOT, "out", "renders");
export const DATABASE_PATH = path.join(DATA_DIR, "clip-factory.sqlite");
export const SEGMENT_MS = 60_000;
export const LIVE_VIDEO_RETENTION_MS = Number(process.env.LIVE_VIDEO_RETENTION_MS ?? 30 * 60_000);
export const VOD_AUDIO_FORMAT = process.env.VOD_AUDIO_FORMAT ?? "m4a";
export const FILLER_REMOVAL_MODE = process.env.FILLER_REMOVAL_MODE ?? "conservative";
export const MIN_SAFE_CUT_SILENCE_MS = Number(process.env.MIN_SAFE_CUT_SILENCE_MS ?? 300);
export const PREFERRED_SAFE_CUT_SILENCE_MS = Number(process.env.PREFERRED_SAFE_CUT_SILENCE_MS ?? 450);
export const MIN_KEEP_SPAN_MS = Number(process.env.MIN_KEEP_SPAN_MS ?? 1200);
export const ENABLE_AUDIO_FIRST_VOD = process.env.ENABLE_AUDIO_FIRST_VOD !== "false";
export const ENABLE_COMPACTED_RENDERING = process.env.ENABLE_COMPACTED_RENDERING !== "false";
export const SUBTITLE_MODE = process.env.SUBTITLE_MODE ?? "phrase_1_4";
export const RENDER_INTRO_MS = Number(process.env.RENDER_INTRO_MS ?? 3000);
export const DEFAULT_TEMPLATE_FONT_FAMILY = process.env.DEFAULT_TEMPLATE_FONT_FAMILY ?? "Archivo";
export const DEFAULT_TEMPLATE_FONT_SOURCE = process.env.DEFAULT_TEMPLATE_FONT_SOURCE ?? "google";
export const ANALYSIS_WINDOW_MS = 5 * 60_000;
export const MIN_CLIP_MS = Number(process.env.MIN_CLIP_MS ?? 20_000);
export const MAX_CLIP_MS = Number(process.env.MAX_CLIP_MS ?? 90_000);
export const ANALYSIS_INTERVAL_MS = 30_000;
export const RENDER_STALE_MS = Number(process.env.RENDER_STALE_MS ?? 20 * 60_000);
export const RENDER_WORKER_CONCURRENCY = Number(process.env.RENDER_WORKER_CONCURRENCY ?? 1);
export const DRIVE_UPLOAD_CONCURRENCY = Number(process.env.DRIVE_UPLOAD_CONCURRENCY ?? 1);
export const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
export const ENABLE_GPT_DIRECTION = process.env.ENABLE_GPT_DIRECTION !== "false";
export const ENABLE_AI_MUSIC = process.env.ENABLE_AI_MUSIC === "true";
export const EDIT_DIRECTOR_MODEL = process.env.EDIT_DIRECTOR_MODEL ?? DEFAULT_OPENAI_MODEL;
export const MAX_DIRECTION_FRAMES = Number(process.env.MAX_DIRECTION_FRAMES ?? 24);
export const ROUGH_CUT_BUFFER_MS = Number(process.env.ROUGH_CUT_BUFFER_MS ?? 1500);
export const MUSIC_PROVIDER = process.env.MUSIC_PROVIDER ?? "none";
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
export const MAX_GPT_DIRECTION_CALLS_PER_CANDIDATE = Number(
  process.env.MAX_GPT_DIRECTION_CALLS_PER_CANDIDATE ?? 3,
);
export const MAX_TOTAL_DIRECTION_FRAMES = Number(process.env.MAX_TOTAL_DIRECTION_FRAMES ?? 24);
export const MAX_ROUGH_DURATION_MS = Number(process.env.MAX_ROUGH_DURATION_MS ?? 120000);
export const EDIT_DIRECTION_PROMPT_VERSION = "edit-director-v1";
export const EDIT_DIRECTION_SCHEMA_VERSION = "edit-direction-schema-v1";
export const RENDERER_VERSION = "clip-renderer-v13";
export const TRANSCRIPTION_LANGUAGE = process.env.TRANSCRIPTION_LANGUAGE ?? "en";
export const PYTHON_BIN = process.env.TRANSCRIPTION_PYTHON_BIN ?? "python3";
export const YT_DLP_COOKIES_FILE = process.env.YT_DLP_COOKIES_FILE ?? null;
export const YT_DLP_COOKIES_FROM_BROWSERS = (process.env.YT_DLP_COOKIES_FROM_BROWSERS ?? "safari,chrome")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
export const YT_DLP_VISITOR_DATA = process.env.YT_DLP_VISITOR_DATA ?? null;
export const WHISPER_CPP_BIN =
  process.env.WHISPER_CPP_BIN ??
  "/Users/jainam_ranka/whisper.cpp/build/bin/whisper-cli";
export const WHISPER_CPP_MODEL =
  process.env.WHISPER_CPP_MODEL ??
  "/Users/jainam_ranka/whisper.cpp/models/ggml-base.en.bin";
export const OUTRO_PUBLIC_PATH = "/outro.mp4";
export const REMOTION_RENDER_PORT = process.env.REMOTION_RENDER_PORT
  ? Number(process.env.REMOTION_RENDER_PORT)
  : null;
export const REMOTION_BROWSER_EXECUTABLE =
  process.env.REMOTION_BROWSER_EXECUTABLE ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const REMOTION_CHROME_MODE =
  process.env.REMOTION_CHROME_MODE ??
  "chrome-for-testing";
export const REMOTION_RENDER_CONCURRENCY = Number(process.env.REMOTION_RENDER_CONCURRENCY ?? 1);
export const REMOTION_OFFTHREAD_VIDEO_THREADS = Number(process.env.REMOTION_OFFTHREAD_VIDEO_THREADS ?? 1);
export const DEFAULT_RENDER_FORMAT = "vertical";
export const GOOGLE_DRIVE_PARENT_FOLDER_ID = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID ?? null;
export const GOOGLE_DRIVE_CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID ?? null;
export const GOOGLE_DRIVE_CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? null;
export const GOOGLE_DRIVE_REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN ?? null;
export const GOOGLE_DRIVE_REDIRECT_URI = process.env.GOOGLE_DRIVE_REDIRECT_URI ?? null;
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? null;
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? null;
export const TELEGRAM_POLL_INTERVAL_MS = Number(process.env.TELEGRAM_POLL_INTERVAL_MS ?? 2_000);
