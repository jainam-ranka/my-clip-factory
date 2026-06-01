import {
  ANALYSIS_INTERVAL_MS,
  DEFAULT_RENDER_FORMAT,
  DRIVE_UPLOAD_CONCURRENCY,
  ENABLE_AUDIO_FIRST_VOD,
  LIVE_VIDEO_RETENTION_MS,
  MAX_CLIP_MS,
  MIN_CLIP_MS,
  RENDER_STALE_MS,
  RENDER_WORKER_CONCURRENCY,
  SEGMENT_MS,
} from "@/lib/config";
import fs from "node:fs";
import { clamp, overlapMs } from "@/lib/utils";
import { analyzeTranscriptWindow } from "./analyzer";
import {
  captureAudioSegmentFromSourceFile,
  captureSegment,
  downloadApprovedVideoRange,
  downloadSourceAudio,
  getMediaDurationMs,
} from "./ingestion";
import { isAbortError, throwIfAborted } from "./process";
import {
  createApprovedCandidate,
  createCandidate,
  createRenderJob,
  getLatestEditDirectionPlan,
  getCandidate,
  getRun,
  getRunDetail,
  insertSegment,
  listApprovedMediaRanges,
  listActiveRuns,
  listCandidatesForRun,
  listClipSpans,
  listPendingDriveUploads,
  listPendingRenderJobs,
  listRecentTokens,
  markRenderJob,
  markRun,
  markSegmentFailed,
  markSegmentProcessed,
  replaceClipSpans,
  resetStaleDriveUploads,
  resetStaleRenderingJobs,
  setCandidateRenderConfig,
  setCandidateCompaction,
  setCandidateStatus,
  setRunLabel,
  upsertEditDirectionPlan,
  upsertApprovedMediaRange,
  updateCandidateWindow,
  updateSegmentVideoPath,
} from "./repository";
import { renderApprovedClip } from "./rendering";
import { verifyRenderedClip } from "./render-verification";
import { extractRawClip } from "./raw-render";
import { ensureRunDirectories, getApprovedCandidateDir, getRunSourceAudioPath } from "./fs";
import { buildConservativeClipSpans } from "./compaction";
import { createEditDirectionPlan, editDirectionMetadata, fallbackEditDirectionPlan, validateEditDirectionPlan } from "./edit-direction";
import { generateDavinciTimeline } from "./davinci";
import { uploadRenderedClipToDrive } from "./google-drive";
import { ensureSourceMetadata, readSourceMetadata, type SourceMetadata } from "./source-metadata";
import { transcribeSegment } from "./transcription";
import { extractVisualEvidenceFrames } from "./visual-evidence";

type RuntimeState = {
  started: boolean;
  timer: NodeJS.Timeout | null;
  activeRuns: Set<string>;
  activeRenders: Set<string>;
  activeDriveUploads: Set<string>;
  runControllers: Map<string, AbortController>;
  renderControllers: Map<string, { controller: AbortController; runId: string }>;
  driveUploadControllers: Map<string, AbortController>;
};

const LIVE_METADATA_REFRESH_MS = 5 * 60_000;
const LIVE_END_GRACE_MS = SEGMENT_MS * 2;
const CLIP_BOUNDARY_START_PAD_MS = 300;
const CLIP_BOUNDARY_END_PAD_MS = 450;
const CLIP_BOUNDARY_MAX_EXTENSION_MS = 8_000;
const CLIP_BOUNDARY_POSTROLL_SENTENCE_GAP_MS = 1_600;
const CLIP_BOUNDARY_POSTROLL_SENTENCE_MAX_MS = 4_500;
const SENTENCE_END_PATTERN = /[.!?]["')\]]?$/;

declare global {
  // eslint-disable-next-line no-var
  var __clipFactoryRuntimeState: RuntimeState | undefined;
}

function getRuntimeState(): RuntimeState {
  if (!globalThis.__clipFactoryRuntimeState) {
    globalThis.__clipFactoryRuntimeState = {
      started: false,
      timer: null,
      activeRuns: new Set<string>(),
      activeRenders: new Set<string>(),
      activeDriveUploads: new Set<string>(),
      runControllers: new Map<string, AbortController>(),
      renderControllers: new Map<string, { controller: AbortController; runId: string }>(),
      driveUploadControllers: new Map<string, AbortController>(),
    };
  }

  return globalThis.__clipFactoryRuntimeState;
}

function isFatalRunError(message: string) {
  return (
    message.includes("Unsupported URL") ||
    message.includes("Sign in to confirm you’re not a bot") ||
    message.includes("Sign in to confirm you're not a bot") ||
    message.includes("HTTP Error 429") ||
    message.includes("Missing required Visitor Data") ||
    message.includes("This source does not expose a downloadable stream format") ||
    message.includes("This format cannot be partially downloaded")
  );
}

function captureErrorCode(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("sign in") || normalized.includes("bot") || normalized.includes("visitor data")) return "needs_auth" as const;
  if (normalized.includes("429") || normalized.includes("rate limit") || normalized.includes("too many requests")) return "rate_limited" as const;
  if (normalized.includes("scheduled") || normalized.includes("not started") || normalized.includes("upcoming")) return "stream_not_started" as const;
  if (normalized.includes("ended") || normalized.includes("post_live")) return "stream_ended" as const;
  if (normalized.includes("unsupported")) return "unsupported_source" as const;
  return "temporary_capture_error" as const;
}

function sourceModeFromMetadata(metadata: SourceMetadata) {
  if (metadata.sourceMode !== "unknown") {
    return metadata.sourceMode;
  }
  if (metadata.isLive === false) return "vod" as const;
  if (metadata.isLive === true) return "live" as const;
  return "unknown" as const;
}

async function processRun(runId: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const detail = getRunDetail(runId);
  if (!detail || detail.run.status !== "active") {
    return;
  }

  const existingMetadata = readSourceMetadata(runId);
  const lastSegmentTime = detail.run.lastSegmentAt ? Date.parse(detail.run.lastSegmentAt) : 0;
  const shouldRefreshLiveMetadata =
    existingMetadata?.isLive === true &&
    (
      !lastSegmentTime ||
      Date.now() - lastSegmentTime > LIVE_END_GRACE_MS ||
      Date.now() - (existingMetadata.fetchedAtMs ?? 0) > LIVE_METADATA_REFRESH_MS
    );
  let sourceMetadata = readSourceMetadata(runId);
  try {
    sourceMetadata = await ensureSourceMetadata({
      runId,
      url: detail.run.sourceUrl,
      forceRefresh: shouldRefreshLiveMetadata,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not inspect source metadata.";
    markRun(runId, {
      status: isFatalRunError(message) ? "error" : "active",
      errorMessage: message,
      lastCaptureErrorCode: captureErrorCode(message),
    });
    return;
  }

  if (!sourceMetadata) {
    markRun(runId, {
      status: "error",
      errorMessage: "Could not inspect source metadata.",
    });
    return;
  }

  if (sourceMetadata.title && detail.run.label !== sourceMetadata.title) {
    setRunLabel(runId, sourceMetadata.title);
  }
  const isRecordedVideo = sourceMetadata.isLive === false;
  const sourceMode = sourceModeFromMetadata(sourceMetadata);
  markRun(runId, {
    sourceMode,
    sourceDurationMs: sourceMetadata.durationMs,
    sourceMediaStrategy:
      sourceMode === "vod" && ENABLE_AUDIO_FIRST_VOD
        ? "audio_first"
        : sourceMode === "live"
          ? "rolling_live_cache"
          : "legacy_segment_video",
    tempVideoRetentionMs: LIVE_VIDEO_RETENTION_MS,
  });

  const latestRun = getRunDetail(runId)?.run ?? detail.run;
  if (detail.run.platform === "youtube" && !isRecordedVideo && !sourceMetadata.liveCapture) {
    markRun(runId, {
      status: sourceMetadata.liveStatus === "post_live" ? "ready" : "active",
      errorMessage: sourceMetadata.liveStatus === "is_upcoming"
        ? "Waiting for the scheduled YouTube live stream to start."
        : "Waiting for YouTube to expose a downloadable live stream.",
      lastCaptureErrorCode:
        sourceMetadata.liveStatus === "is_upcoming"
          ? "stream_not_started"
          : sourceMetadata.liveStatus === "post_live"
            ? "stream_ended"
            : "temporary_capture_error",
    });
    return;
  }

  if (
    sourceMetadata?.isLive === false &&
    existingMetadata?.isLive === true &&
    lastSegmentTime > 0 &&
    Date.now() - lastSegmentTime > LIVE_END_GRACE_MS
  ) {
    markRun(runId, {
      status: "ready",
      errorMessage: null,
    });
    return;
  }

  if (
    isRecordedVideo &&
    typeof sourceMetadata.durationMs === "number" &&
    detail.run.captureCursorMs >= sourceMetadata.durationMs
  ) {
    markRun(runId, {
      status: "ready",
      errorMessage: null,
    });
    return;
  }

  if (!isRecordedVideo && lastSegmentTime > 0 && Date.now() - lastSegmentTime < SEGMENT_MS) {
    return;
  }

  const directories = ensureRunDirectories(runId);
  const segmentIndex = Math.floor(detail.run.captureCursorMs / SEGMENT_MS);

  const hasRecordedDuration = typeof sourceMetadata.durationMs === "number";
  const canCaptureRecordedSectionsWithoutDuration = isRecordedVideo && detail.run.platform === "x";
  const audioFirstVod = isRecordedVideo && ENABLE_AUDIO_FIRST_VOD && hasRecordedDuration;
  const expiresAt =
    !isRecordedVideo ? new Date(Date.now() + LIVE_VIDEO_RETENTION_MS).toISOString() : null;
  const segment = insertSegment({
    runId,
    segmentIndex,
    startMs: detail.run.captureCursorMs,
    endMs: detail.run.captureCursorMs + SEGMENT_MS,
    videoPath: "",
    mediaType: audioFirstVod ? "audio" : "video",
    retentionStatus: !isRecordedVideo ? "temporary" : "retained",
    expiresAt,
  });

  try {
    if (isRecordedVideo && !hasRecordedDuration && !canCaptureRecordedSectionsWithoutDuration) {
      throw new Error("The recorded source is missing duration metadata.");
    }

    let analysisAudioPath = latestRun.analysisAudioPath;
    if (audioFirstVod) {
      analysisAudioPath = analysisAudioPath || getRunSourceAudioPath(runId);
      if (analysisAudioPath && fs.existsSync(analysisAudioPath) && sourceMetadata.durationMs) {
        const audioDurationMs = await getMediaDurationMs(analysisAudioPath);
        if (!audioDurationMs || audioDurationMs < sourceMetadata.durationMs - 2_000) {
          fs.rmSync(analysisAudioPath, { force: true });
        }
      }

      if (!analysisAudioPath || !fs.existsSync(analysisAudioPath)) {
        analysisAudioPath = await downloadSourceAudio({
          url: detail.run.sourceUrl,
          outputPath: getRunSourceAudioPath(runId),
          signal,
        });
        markRun(runId, { analysisAudioPath });
      }
    }

    const captured = audioFirstVod && analysisAudioPath
      ? await captureAudioSegmentFromSourceFile({
          sourcePath: analysisAudioPath,
          outputDir: directories.segments,
          segmentIndex,
          startMs: detail.run.captureCursorMs,
          signal,
        })
      : await captureSegment({
          url: detail.run.sourceUrl,
          outputDir: directories.segments,
          segmentIndex,
          startMs: detail.run.captureCursorMs,
          sourceMetadata,
          signal,
        });

    if (!segment) {
      throw new Error("Failed to create a segment record.");
    }

    const storedSegment = updateSegmentVideoPath(segment.id, captured.finalPath);
    if (!storedSegment) {
      throw new Error("Could not persist the downloaded segment path.");
    }

    const transcript = await transcribeSegment({
      runId,
      segmentId: segment.id,
      videoPath: captured.finalPath,
      startOffsetMs: detail.run.captureCursorMs,
      outputDir: directories.transcripts,
      signal,
    });

    markSegmentProcessed(segment.id, transcript);
    markRun(runId, {
      captureCursorMs: captured.endMs,
      lastSegmentAt: new Date().toISOString(),
      errorMessage: null,
      lastCaptureErrorCode: null,
    });
  } catch (error) {
    if (isAbortError(error)) {
      if (segment) {
        markSegmentFailed(segment.id, "Run was stopped before the segment finished processing.");
      }

      const currentRun = getRunDetail(runId)?.run;
      markRun(runId, {
        status: currentRun?.status === "stopped" ? "stopped" : "error",
        errorMessage: currentRun?.status === "stopped" ? null : "Run processing was aborted.",
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown pipeline error.";
    const refreshedMetadata =
      !isRecordedVideo && lastSegmentTime > 0 && Date.now() - lastSegmentTime > LIVE_END_GRACE_MS
        ? await ensureSourceMetadata({
            runId,
            url: detail.run.sourceUrl,
            forceRefresh: true,
          }).catch(() => sourceMetadata)
        : sourceMetadata;
    if (
      isRecordedVideo &&
      (
        message.includes("yt-dlp finished without leaving a usable media file") ||
        message.includes("yt-dlp completed but no raw segment path could be resolved")
      )
    ) {
      markRun(runId, {
        status: "ready",
        errorMessage: null,
      });
      return;
    }

    if (
      !isRecordedVideo &&
      refreshedMetadata?.isLive === false &&
      (
        message.includes("yt-dlp finished without leaving a usable media file") ||
        message.includes("yt-dlp completed but no raw segment path could be resolved") ||
        message.includes("ffmpeg could not capture the YouTube live DVR segment")
      )
    ) {
      markRun(runId, {
        status: "ready",
        errorMessage: null,
      });
      return;
    }

    if (segment) {
      markSegmentFailed(segment.id, message);
    }
    markRun(runId, {
      status: isFatalRunError(message) ? "error" : "active",
      errorMessage: message,
      lastCaptureErrorCode: captureErrorCode(message),
    });
    return;
  }

  const latest = getRunDetail(runId);
  if (!latest) {
    return;
  }

  throwIfAborted(signal);
  const lastAnalysis = latest.run.lastAnalysisAt ? Date.parse(latest.run.lastAnalysisAt) : 0;
  if (Date.now() - lastAnalysis < ANALYSIS_INTERVAL_MS) {
    return;
  }

  const decision = await analyzeTranscriptWindow(latest.transcript);
  markRun(runId, {
    lastAnalysisAt: new Date().toISOString(),
  });

  if (!decision.worthClipping) {
    return;
  }

  const existingCandidates = listCandidatesForRun(runId);
  const isDuplicate = existingCandidates.some((candidate) => {
    const overlap = overlapMs(
      candidate.suggestedStartMs,
      candidate.suggestedEndMs,
      decision.suggestedStart,
      decision.suggestedEnd,
    );
    return overlap >= 15_000;
  });

  if (!isDuplicate) {
    const candidate = createCandidate(runId, decision);
    if (candidate && latest.run.autoApproveClips) {
      setCandidateRenderConfig(candidate.id, buildDefaultRenderConfig());
      const approved = getCandidate(candidate.id);
      if (approved) {
        createApprovedCandidateRenderJobs(candidate.id);
      }
    }
  }
}

function buildDefaultRenderConfig() {
  return {
    templateId: null,
    templateName: "Auto-approved default",
    mode: "edited" as const,
    aiMotionEnabled: true,
    motionIntensity: "subtle" as const,
    allowPunchIns: true,
    maxMotionEvents: 4,
    enableCaptions: true,
    enableMotion: true,
    enableColor: true,
    enableMusic: false,
    enableCompaction: true,
    colorGradePreset: "neutral" as const,
    aiMusicEnabled: false,
    introSrc: null,
    outroSrc: null,
    musicSrc: null,
    musicPreset: "balanced" as const,
    musicVolume: null,
    musicFadeIn: true,
    musicFadeOut: true,
    captionStyle: "pill" as const,
    captionSize: "md" as const,
    captionColor: null,
    captionPlacement: "bottom" as const,
    outputFileName: null,
    videoLayout: null,
    videoFillMode: "blur" as const,
    fontFamily: null,
    fontSource: null,
    subtitleMode: "phrase_1_4" as const,
  };
}

function createApprovedCandidateRenderJobs(candidateId: string) {
  const candidate = getCandidate(candidateId);
  if (!candidate) {
    return [];
  }

  if (candidate.status !== "approved") {
    setCandidateStatus(candidateId, "approved");
  }

  return queueCandidateForRenderWithFormats(candidateId, [candidate.renderConfig?.videoLayout ?? DEFAULT_RENDER_FORMAT]);
}

function resolveClipSentenceBoundaries(input: {
  runId: string;
  startMs: number;
  endMs: number;
  sourceDurationMs: number | null;
}) {
  const searchStartMs = Math.max(0, input.startMs - 10_000);
  const searchEndMs = input.endMs + CLIP_BOUNDARY_MAX_EXTENSION_MS;
  const tokens = listRecentTokens(input.runId, searchStartMs)
    .filter((token) => token.endMs >= searchStartMs && token.startMs <= searchEndMs)
    .sort((left, right) => left.startMs - right.startMs);

  if (tokens.length === 0) {
    return { startMs: input.startMs, endMs: input.endMs };
  }

  const firstIncluded = tokens.find((token) => token.endMs > input.startMs);
  let lastIncludedIndex = -1;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].startMs < input.endMs) {
      lastIncludedIndex = index;
      break;
    }
  }
  const lastIncluded = lastIncludedIndex >= 0 ? tokens[lastIncludedIndex] : null;

  let nextStartMs = firstIncluded
    ? Math.max(0, firstIncluded.startMs - CLIP_BOUNDARY_START_PAD_MS)
    : input.startMs;
  let nextEndMs = lastIncluded
    ? lastIncluded.endMs + CLIP_BOUNDARY_END_PAD_MS
    : input.endMs;
  let selectedEndIndex = lastIncludedIndex;

  if (lastIncludedIndex >= 0) {
    for (let index = lastIncludedIndex; index < tokens.length; index += 1) {
      const token = tokens[index];
      const next = tokens[index + 1] ?? null;
      const reachedSentenceEnd = SENTENCE_END_PATTERN.test(token.text.trim());
      const reachedPause = next ? next.startMs - token.endMs >= 700 : false;
      const candidateEndMs = token.endMs + CLIP_BOUNDARY_END_PAD_MS;
      const extensionMs = candidateEndMs - input.endMs;

      if (extensionMs > CLIP_BOUNDARY_MAX_EXTENSION_MS) {
        break;
      }

      nextEndMs = candidateEndMs;
      selectedEndIndex = index;
      if (reachedSentenceEnd || reachedPause) {
        break;
      }
    }
  }

  const selectedEndToken = selectedEndIndex >= 0 ? tokens[selectedEndIndex] : null;
  const postrollStartToken = selectedEndIndex >= 0 ? tokens[selectedEndIndex + 1] : null;
  if (
    selectedEndToken &&
    postrollStartToken &&
    SENTENCE_END_PATTERN.test(selectedEndToken.text.trim()) &&
    postrollStartToken.startMs - selectedEndToken.endMs <= CLIP_BOUNDARY_POSTROLL_SENTENCE_GAP_MS
  ) {
    for (let index = selectedEndIndex + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      const next = tokens[index + 1] ?? null;
      const candidateEndMs = token.endMs + CLIP_BOUNDARY_END_PAD_MS;
      const postrollSentenceMs = candidateEndMs - postrollStartToken.startMs;
      const extensionMs = candidateEndMs - input.endMs;

      if (
        postrollSentenceMs > CLIP_BOUNDARY_POSTROLL_SENTENCE_MAX_MS ||
        extensionMs > CLIP_BOUNDARY_MAX_EXTENSION_MS
      ) {
        break;
      }

      nextEndMs = candidateEndMs;
      if (SENTENCE_END_PATTERN.test(token.text.trim()) || (next && next.startMs - token.endMs >= 900)) {
        break;
      }
    }
  }

  const maxAllowedEndMs = Math.max(
    input.endMs,
    Math.min(
      input.sourceDurationMs ?? Number.POSITIVE_INFINITY,
      input.endMs + CLIP_BOUNDARY_MAX_EXTENSION_MS,
      input.startMs + MAX_CLIP_MS,
    ),
  );
  const minAllowedEndMs = Math.min(
    input.sourceDurationMs ?? Number.POSITIVE_INFINITY,
    input.startMs + MIN_CLIP_MS,
  );
  nextEndMs = Math.min(Math.max(nextEndMs, input.endMs, minAllowedEndMs), maxAllowedEndMs);

  if (nextEndMs <= nextStartMs) {
    return { startMs: input.startMs, endMs: input.endMs };
  }

  return {
    startMs: Math.round(nextStartMs),
    endMs: Math.round(nextEndMs),
  };
}

export async function prepareApprovedCandidateForRender(candidateId: string, signal?: AbortSignal) {
  let candidate = getCandidate(candidateId);
  if (!candidate) {
    throw new Error("Candidate not found.");
  }
  const run = getRun(candidate.runId);
  if (!run) {
    throw new Error("Run not found.");
  }

  const expanded = resolveClipSentenceBoundaries({
    runId: run.id,
    startMs: candidate.suggestedStartMs,
    endMs: candidate.suggestedEndMs,
    sourceDurationMs: run.sourceDurationMs,
  });
  if (
    expanded.startMs !== candidate.suggestedStartMs ||
    expanded.endMs !== candidate.suggestedEndMs
  ) {
    candidate = updateCandidateWindow(candidate.id, {
      suggestedStartMs: expanded.startMs,
      suggestedEndMs: expanded.endMs,
    }) ?? candidate;
  }

  const existingRanges = listApprovedMediaRanges(candidate.id);
  const hasCoveringRange = existingRanges.some(
    (range) =>
      range.sourceStartMs <= candidate.suggestedStartMs &&
      range.sourceEndMs >= candidate.suggestedEndMs &&
      fs.existsSync(range.videoPath),
  );
  if (!hasCoveringRange && run.sourceMode === "vod") {
    const approvedDir = getApprovedCandidateDir(run.id, candidate.id);
    const outputPath = `${approvedDir}/source-range-000.mp4`;
    await downloadApprovedVideoRange({
      url: run.sourceUrl,
      outputPath,
      startMs: candidate.suggestedStartMs,
      endMs: candidate.suggestedEndMs,
      signal,
    });
    upsertApprovedMediaRange({
      runId: run.id,
      candidateId: candidate.id,
      sourceStartMs: candidate.suggestedStartMs,
      sourceEndMs: candidate.suggestedEndMs,
      videoPath: outputPath,
      mediaOrigin: "vod_range_download",
    });
  }

  if (candidate.renderConfig?.mode === "raw" || candidate.renderConfig?.enableCompaction === false) {
    replaceClipSpans(candidate.id, [{
      runId: run.id,
      sourceStartMs: candidate.suggestedStartMs,
      sourceEndMs: candidate.suggestedEndMs,
      outputStartMs: 0,
      outputEndMs: candidate.suggestedEndMs - candidate.suggestedStartMs,
      reason: candidate.renderConfig?.mode === "raw" ? "Raw mode bypasses compaction." : "Template disables compaction.",
    }]);
    setCandidateCompaction(candidate.id, {
      compactionStatus: candidate.renderConfig?.mode === "raw" ? "disabled" : "ready",
      compactionMode: null,
      compactStartMs: 0,
      compactEndMs: candidate.suggestedEndMs - candidate.suggestedStartMs,
    });
    return {
      sourceStrategy: "continuous" as const,
      clipSpansJson: JSON.stringify(listClipSpans(candidate.id)),
    };
  }

  const existingManualSpans = listClipSpans(candidate.id).filter((span) =>
    span.reason?.startsWith("manual multi-clip"),
  );
  if (existingManualSpans.length > 0) {
    const compactEndMs = Math.max(...existingManualSpans.map((span) => span.outputEndMs));
    setCandidateCompaction(candidate.id, {
      compactionStatus: "ready",
      compactionMode: null,
      compactStartMs: 0,
      compactEndMs,
    });
    return {
      sourceStrategy: existingManualSpans.length > 1 ? "compacted_spans" as const : "continuous" as const,
      clipSpansJson: JSON.stringify(existingManualSpans),
    };
  }

  const tokens = listRecentTokens(run.id, candidate.suggestedStartMs)
    .filter((token) => token.startMs <= candidate.suggestedEndMs && token.endMs >= candidate.suggestedStartMs);
  const spans = replaceClipSpans(candidate.id, buildConservativeClipSpans({ candidate, tokens }));
  const isCompacted = spans.length > 1 || spans.some((span) => span.sourceStartMs !== candidate.suggestedStartMs || span.sourceEndMs !== candidate.suggestedEndMs);
  setCandidateCompaction(candidate.id, {
    compactionStatus: "ready",
    compactionMode: "conservative",
    compactStartMs: 0,
    compactEndMs: spans.at(-1)?.outputEndMs ?? candidate.suggestedEndMs - candidate.suggestedStartMs,
  });

  const refreshedCandidate = getCandidate(candidate.id) ?? candidate;
  const existingDirection = getLatestEditDirectionPlan(candidate.id);
  if (!existingDirection && refreshedCandidate.renderConfig?.mode !== "raw") {
    const frameImageDataUrls = await extractVisualEvidenceFrames({
      runId: run.id,
      candidate: refreshedCandidate,
      signal,
    });
    const directionPlan = await createEditDirectionPlan({
      candidate: refreshedCandidate,
      renderConfig: refreshedCandidate.renderConfig,
      transcriptTokens: tokens,
      frameImageDataUrls,
    });
    upsertEditDirectionPlan({
      runId: run.id,
      candidateId: candidate.id,
      plan: directionPlan,
      ...editDirectionMetadata(),
    });
  }

  return {
    sourceStrategy: isCompacted ? "compacted_spans" as const : "continuous" as const,
    clipSpansJson: JSON.stringify(spans),
  };
}

async function processRender(renderId: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const render = listPendingRenderJobs().find((job) => job.id === renderId);
  if (!render) {
    return;
  }

  const candidate = getCandidate(render.candidateId);
  if (!candidate) {
    markRenderJob(renderId, {
      status: "error",
      errorMessage: "Candidate missing.",
    });
    return;
  }

  let heartbeat: NodeJS.Timeout | null = null;
  let latestProgress = 3;
  let outputPath: string | null = null;
  try {
    markRenderJob(renderId, { status: "rendering", progressPercent: 3, errorMessage: null });
    heartbeat = setInterval(() => {
      markRenderJob(renderId, {
        status: "rendering",
        progressPercent: latestProgress,
        errorMessage: null,
      });
    }, 30_000);
    if (render.renderConfig?.mode === "raw") {
      outputPath = await extractRawClip({
          runId: render.runId,
          candidate,
          renderSignature: render.renderSignature,
          signal,
        });
    } else {
      const approvedRender = await renderApprovedClip({
          renderId,
          runId: render.runId,
          candidate,
          format: render.format,
          renderConfig: render.renderConfig,
          renderSignature: render.renderSignature,
          clipSpansJson: render.clipSpansJson,
          signal,
          onProgress: (progressPercent) => {
            latestProgress = progressPercent;
            markRenderJob(renderId, {
              status: "rendering",
              progressPercent,
              errorMessage: null,
            });
          },
        });
      outputPath = approvedRender.outputPath;
      markRenderJob(renderId, { captionTimingOffsetMs: approvedRender.captionTimingOffsetMs });
    }
    latestProgress = 98;
    markRenderJob(renderId, {
      status: "rendering",
      progressPercent: latestProgress,
      errorMessage: null,
    });
    await verifyRenderedClip({ render, candidate, outputPath, signal });
    generateDavinciTimeline({ render, candidate, outputPath });
    markRenderJob(renderId, {
      status: "rendered",
      progressPercent: null,
      outputPath,
      driveFileId: null,
      driveFolderId: null,
      driveWebViewLink: null,
      driveUploadStatus: "pending",
      driveErrorMessage: null,
      errorMessage: null,
    });
  } catch (error) {
    if (isAbortError(error)) {
      markRenderJob(renderId, {
        status: "error",
        progressPercent: 0,
        errorMessage: "Render was interrupted.",
      });
      return;
    }

    markRenderJob(renderId, {
      status: "error",
      progressPercent: 0,
      outputPath,
      errorMessage: error instanceof Error ? error.message : "Unknown render error.",
    });
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
}

async function processDriveUpload(renderId: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const render = listPendingDriveUploads(50).find((job) => job.id === renderId);
  if (!render?.outputPath) {
    return;
  }

  const run = getRunDetail(render.runId)?.run;
  if (!run) {
    markRenderJob(renderId, {
      driveUploadStatus: "error",
      driveErrorMessage: "Run missing for Drive upload.",
    });
    return;
  }

  let heartbeat: NodeJS.Timeout | null = null;
  try {
    markRenderJob(renderId, {
      driveUploadStatus: "uploading",
      driveErrorMessage: null,
    });
    heartbeat = setInterval(() => {
      markRenderJob(renderId, {
        driveUploadStatus: "uploading",
        driveErrorMessage: null,
      });
    }, 30_000);
    const driveUpload = await uploadRenderedClipToDrive({
      runId: run.id,
      runLabel: run.label,
      outputPath: render.outputPath,
    });

    if (!driveUpload) {
      markRenderJob(renderId, {
        driveUploadStatus: "not_configured",
        driveErrorMessage: null,
      });
      return;
    }

    markRenderJob(renderId, {
      driveFileId: driveUpload.driveFileId,
      driveFolderId: driveUpload.driveFolderId,
      driveWebViewLink: driveUpload.driveWebViewLink,
      driveUploadStatus: "uploaded",
      driveErrorMessage: null,
    });
  } catch (error) {
    if (isAbortError(error)) {
      markRenderJob(renderId, {
        driveUploadStatus: "pending",
        driveErrorMessage: null,
      });
      return;
    }

    markRenderJob(renderId, {
      driveUploadStatus: "error",
      driveErrorMessage: error instanceof Error ? error.message : "Unknown Drive upload error.",
    });
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
}

async function tickRuntime() {
  const state = getRuntimeState();
  resetStaleRenderingJobs(new Date(Date.now() - RENDER_STALE_MS).toISOString());
  resetStaleDriveUploads(new Date(Date.now() - RENDER_STALE_MS).toISOString());
  const runs = listActiveRuns();

  await Promise.all(
    runs.map(async (run) => {
      if (state.activeRuns.has(run.id)) {
        return;
      }

      state.activeRuns.add(run.id);
      const controller = new AbortController();
      state.runControllers.set(run.id, controller);
      try {
        await processRun(run.id, controller.signal);
      } finally {
        state.activeRuns.delete(run.id);
        state.runControllers.delete(run.id);
      }
    }),
  );

  const renderSlots = Math.max(0, RENDER_WORKER_CONCURRENCY - state.activeRenders.size);
  const pendingRenders = listPendingRenderJobs()
    .filter((job) => job.status === "pending" && !state.activeRenders.has(job.id))
    .slice(0, renderSlots);

  await Promise.all(
    pendingRenders.map(async (pendingRender) => {
      state.activeRenders.add(pendingRender.id);
      const controller = new AbortController();
      state.renderControllers.set(pendingRender.id, {
        controller,
        runId: pendingRender.runId,
      });
      try {
        await processRender(pendingRender.id, controller.signal);
      } finally {
        state.activeRenders.delete(pendingRender.id);
        state.renderControllers.delete(pendingRender.id);
      }
    }),
  );

  const driveUploadSlots = Math.max(0, DRIVE_UPLOAD_CONCURRENCY - state.activeDriveUploads.size);
  const pendingDriveUploads = listPendingDriveUploads(driveUploadSlots)
    .filter((job) => !state.activeDriveUploads.has(job.id));

  await Promise.all(
    pendingDriveUploads.map(async (pendingUpload) => {
      state.activeDriveUploads.add(pendingUpload.id);
      const controller = new AbortController();
      state.driveUploadControllers.set(pendingUpload.id, controller);
      try {
        await processDriveUpload(pendingUpload.id, controller.signal);
      } finally {
        state.activeDriveUploads.delete(pendingUpload.id);
        state.driveUploadControllers.delete(pendingUpload.id);
      }
    }),
  );
}

export function ensureAppRuntime() {
  const state = getRuntimeState();
  if (state.started) {
    return;
  }

  state.started = true;
  void tickRuntime();
  state.timer = setInterval(() => {
    void tickRuntime();
  }, 5_000);
}

export function cancelRunActivity(runId: string) {
  const state = getRuntimeState();
  state.runControllers.get(runId)?.abort();
}

export function queueCandidateForRender(candidateId: string) {
  const candidate = getCandidate(candidateId);
  if (!candidate || candidate.status !== "approved") {
    return [];
  }

  return queueCandidateForRenderWithFormats(candidateId, [candidate.renderConfig?.videoLayout ?? DEFAULT_RENDER_FORMAT]);
}

export function queueCandidateForRenderWithFormats(
  candidateId: string,
  formats: Array<"vertical" | "landscape">,
) {
  const candidate = getCandidate(candidateId);
  if (!candidate || candidate.status !== "approved") {
    return [];
  }

  const uniqueFormats = Array.from(new Set(formats));
  const directionPlan =
    candidate.renderConfig?.mode === "raw"
      ? null
      : getLatestEditDirectionPlan(candidate.id) ??
        upsertEditDirectionPlan({
          runId: candidate.runId,
          candidateId: candidate.id,
          plan: validateEditDirectionPlan({
            rawPlan: fallbackEditDirectionPlan({ candidate, renderConfig: candidate.renderConfig }),
            candidate,
            renderConfig: candidate.renderConfig,
          }),
          ...editDirectionMetadata(),
        });
  const created = [
    ...uniqueFormats.map((format) =>
      createRenderJob({
        runId: candidate.runId,
        candidateId: candidate.id,
        format,
        renderConfig: candidate.renderConfig,
        sourceStrategy: listClipSpans(candidate.id).length > 1 ? "compacted_spans" : "continuous",
        clipSpansJson: JSON.stringify({
          spans: listClipSpans(candidate.id),
          directionPlanSignature: directionPlan?.planSignature ?? null,
        }),
      }),
    ),
  ];

  return created;
}

export async function createManualRender(input: {
  runId: string;
  startMs: number;
  endMs: number;
  title?: string;
  hook?: string;
  introSrc?: string | null;
  formats?: Array<"vertical" | "landscape">;
}) {
  const run = getRunDetail(input.runId);
  if (!run) {
    throw new Error("Run not found.");
  }

  const maxCapturedMs = Math.max(0, run.run.captureCursorMs);
  const safeStart = clamp(input.startMs, 0, Math.max(0, Math.min(maxCapturedMs, input.endMs) - MIN_CLIP_MS));
  const safeEnd = clamp(input.endMs, safeStart + MIN_CLIP_MS, Math.min(maxCapturedMs, safeStart + MAX_CLIP_MS));

  if (safeEnd <= safeStart) {
    throw new Error("That timestamp range has not been captured yet.");
  }

  const candidate = createApprovedCandidate(input.runId, {
    reason: "Manual timestamp render requested from the dashboard.",
    confidence: 1,
    suggestedStart: safeStart,
    suggestedEnd: safeEnd,
    title: input.title?.trim() || `${run.run.label} manual clip`,
    hook: input.hook?.trim() || "Manual clip render",
    keywords: ["manual", "timestamp"],
  });

  if (!candidate) {
    throw new Error("Could not create manual render candidate.");
  }

  setCandidateRenderConfig(candidate.id, {
    templateId: null,
    templateName: null,
    mode: "edited",
    aiMotionEnabled: true,
    motionIntensity: "subtle",
    allowPunchIns: true,
    maxMotionEvents: 4,
    enableCaptions: true,
    enableMotion: true,
    enableColor: true,
    enableMusic: false,
    enableCompaction: true,
    colorGradePreset: "neutral",
    aiMusicEnabled: false,
    introSrc: input.introSrc ?? null,
    outroSrc: null,
    musicSrc: null,
    musicPreset: "balanced",
    musicVolume: null,
    musicFadeIn: true,
    musicFadeOut: true,
    captionStyle: "pill",
    captionSize: "md",
    captionColor: null,
    captionPlacement: "bottom",
    outputFileName: null,
    videoLayout: null,
    videoFillMode: "blur",
    fontFamily: null,
    fontSource: null,
    subtitleMode: "phrase_1_4",
  });

  const hydratedCandidate = getCandidate(candidate.id) ?? candidate;
  await prepareApprovedCandidateForRender(hydratedCandidate.id);
  const preparedCandidate = getCandidate(hydratedCandidate.id) ?? hydratedCandidate;

  return {
    candidate: preparedCandidate,
    renderJobs: queueCandidateForRenderWithFormats(preparedCandidate.id, input.formats ?? [DEFAULT_RENDER_FORMAT]),
  };
}
