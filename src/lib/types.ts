export type Platform = "youtube" | "x" | "unknown";

export type RunStatus =
  | "pending"
  | "active"
  | "ready"
  | "error"
  | "stopped";

export type CandidateStatus = "pending" | "approved" | "rejected";

export type RenderStatus = "pending" | "rendering" | "rendered" | "error";
export type DriveUploadStatus = "not_configured" | "pending" | "uploading" | "uploaded" | "error";

export type RenderFormat = "vertical" | "landscape";
export type TemplateMode = "edited" | "raw";
export type CaptionStyle = "pill" | "minimal" | "mono";
export type CaptionSize = "sm" | "md" | "lg";
export type MusicPreset = "subtle" | "balanced" | "loud";
export type CaptionPlacement = "top" | "middle" | "bottom";
export type VideoFillMode = "cover" | "contain" | "blur";
export type SourceMode = "vod" | "live" | "upcoming" | "unknown";
export type SourceMediaStrategy = "audio_first" | "rolling_live_cache" | "legacy_segment_video";
export type CaptureErrorCode =
  | "needs_auth"
  | "rate_limited"
  | "stream_not_started"
  | "stream_ended"
  | "temporary_capture_error"
  | "unsupported_source"
  | null;
export type FontSource = "google" | "system";
export type SubtitleMode = "one_word" | "phrase_1_4";

export type RenderTemplate = {
  id: string;
  name: string;
  mode: TemplateMode;
  aiMotionEnabled: boolean;
  motionIntensity: "none" | "subtle" | "moderate";
  allowPunchIns: boolean;
  maxMotionEvents: number;
  enableCaptions: boolean;
  enableMotion: boolean;
  enableColor: boolean;
  enableMusic: boolean;
  enableCompaction: boolean;
  colorGradePreset: "neutral";
  aiMusicEnabled: boolean;
  introSrc: string | null;
  musicSrc: string | null;
  captionStyle: CaptionStyle;
  captionSize: CaptionSize;
  captionColor: string;
  captionPlacement: CaptionPlacement;
  musicVolume: number;
  musicFadeIn: boolean;
  musicFadeOut: boolean;
  outroSrc: string | null;
  videoLayout: RenderFormat;
  videoFillMode: VideoFillMode;
  fontFamily: string;
  fontSource: FontSource;
  subtitleMode: SubtitleMode;
  createdAt: string;
  updatedAt: string;
};

export type RenderConfig = {
  templateId: string | null;
  templateName: string | null;
  mode: TemplateMode;
  aiMotionEnabled: boolean;
  motionIntensity: "none" | "subtle" | "moderate";
  allowPunchIns: boolean;
  maxMotionEvents: number;
  enableCaptions: boolean;
  enableMotion: boolean;
  enableColor: boolean;
  enableMusic: boolean;
  enableCompaction: boolean;
  colorGradePreset: "neutral";
  aiMusicEnabled: boolean;
  introSrc: string | null;
  outroSrc: string | null;
  musicSrc: string | null;
  musicPreset: MusicPreset;
  musicVolume: number | null;
  musicFadeIn: boolean;
  musicFadeOut: boolean;
  captionStyle: CaptionStyle;
  captionSize: CaptionSize;
  captionColor: string | null;
  captionPlacement: CaptionPlacement;
  outputFileName: string | null;
  videoLayout: RenderFormat | null;
  videoFillMode: VideoFillMode;
  fontFamily: string | null;
  fontSource: FontSource | null;
  subtitleMode: SubtitleMode;
};

export type ClipSourceInput = {
  url: string;
  label?: string;
};

export type IngestionRun = {
  id: string;
  sourceUrl: string;
  platform: Platform;
  label: string;
  status: RunStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  storageDir: string;
  captureCursorMs: number;
  lastSegmentAt: string | null;
  lastAnalysisAt: string | null;
  driveFolderId: string | null;
  autoApproveClips: boolean;
  sourceMode: SourceMode;
  sourceDurationMs: number | null;
  sourceMediaStrategy: SourceMediaStrategy;
  analysisAudioPath: string | null;
  tempVideoRetentionMs: number | null;
  lastCaptureErrorCode: CaptureErrorCode;
};

export type TranscriptToken = {
  id: string;
  runId: string;
  segmentId: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
  tokenKind: "word" | "punctuation" | "noise";
  isFiller: boolean;
  isRemoved: boolean;
  editSource: "transcriber" | "user" | "compactor";
};

export type TranscriptWindow = {
  runId: string;
  startedAtMs: number;
  endedAtMs: number;
  tokens: TranscriptToken[];
};

export type ClipCandidate = {
  id: string;
  runId: string;
  suggestedStartMs: number;
  suggestedEndMs: number;
  confidence: number;
  reason: string;
  title: string;
  hook: string;
  keywords: string[];
  renderConfig: RenderConfig | null;
  status: CandidateStatus;
  compactionStatus: "pending" | "ready" | "disabled" | "error";
  compactionMode: "conservative" | null;
  compactStartMs: number | null;
  compactEndMs: number | null;
  clipSpans?: ClipSpan[];
  createdAt: string;
  updatedAt: string;
};

export type ClipSpan = {
  id: string;
  candidateId: string;
  runId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  outputStartMs: number;
  outputEndMs: number;
  reason: string | null;
  createdAt: string;
};

export type ApprovedMediaRange = {
  id: string;
  runId: string;
  candidateId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  videoPath: string;
  mediaOrigin: "vod_range_download" | "live_cache_copy" | "manual_upload";
  createdAt: string;
};

export type ApprovedClip = {
  candidateId: string;
  runId: string;
  finalStartMs: number;
  finalEndMs: number;
  subtitlePreset: "dynamic-word";
  outputVariants: RenderFormat[];
};

export type RenderJob = {
  id: string;
  runId: string;
  candidateId: string;
  format: RenderFormat;
  renderConfig: RenderConfig | null;
  renderSignature: string | null;
  rendererVersion: string | null;
  captionTimingOffsetMs: number | null;
  status: RenderStatus;
  progressPercent: number | null;
  outputPath: string | null;
  driveFileId: string | null;
  driveFolderId: string | null;
  driveWebViewLink: string | null;
  driveUploadStatus: DriveUploadStatus;
  driveErrorMessage: string | null;
  telegramNotifiedAt: string | null;
  errorMessage: string | null;
  sourceStrategy: "continuous" | "compacted_spans";
  clipSpansJson: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RunDetail = {
  run: IngestionRun;
  capturedMediaMs: number;
  capturedTranscriptMs: number;
  transcript: TranscriptWindow;
  fullTranscriptTokens: TranscriptToken[];
  candidates: ClipCandidate[];
  renderJobs: RenderJob[];
};

export type AnalyzerDecision = {
  worthClipping: boolean;
  reason: string;
  confidence: number;
  suggestedStart: number;
  suggestedEnd: number;
  title: string;
  hook: string;
  keywords: string[];
};

export type CaptionToken = {
  text: string;
  startMs: number;
  endMs: number;
};

export type SubtitleCue = {
  id: string;
  renderId: string;
  candidateId: string;
  runId: string;
  cueIndex: number;
  text: string;
  startMs: number;
  endMs: number;
  isHidden: boolean;
  sourceTokenIds: string[];
  editSource: "generated" | "user";
  createdAt: string;
  updatedAt: string;
};

export type RenderSubtitleCue = {
  text: string;
  startMs: number;
  endMs: number;
  isHidden?: boolean;
};

export type ClipRenderProps = {
  format: RenderFormat;
  videoSrc: string;
  introSrc: string | null;
  outroSrc: string | null;
  musicSrc: string | null;
  musicPreset: MusicPreset;
  musicVolume: number;
  musicFadeInFrames: number;
  musicFadeOutFrames: number;
  sourceAudioFadeOutFrames: number;
  sourceAudioVolume: number;
  transitionFrames: number;
  durationInFrames: number;
  introFrames: number;
  clipFrames: number;
  captions: CaptionToken[];
  subtitleCues?: RenderSubtitleCue[];
  captionTimingOffsetMs: number;
  title: string;
  hook: string;
  captionStyle: CaptionStyle;
  captionFontSize: number;
  captionColor: string;
  captionPlacement: CaptionPlacement;
  videoFillMode: VideoFillMode;
  fontFamily: string;
  fontSource: FontSource;
  subtitleMode: SubtitleMode;
  camera: Array<{
    startMs: number;
    endMs: number;
    preset: "hold" | "slow_push" | "slow_pull" | "subtle_pan" | "punch_in";
    focusX: number;
    focusY: number;
    zoomFrom: number;
    zoomTo: number;
    visualConfidence: number;
  }>;
};

export type AssetOption = {
  label: string;
  value: string;
};

export type RenderAssetOptions = {
  intros: AssetOption[];
  outros: AssetOption[];
  music: AssetOption[];
};
