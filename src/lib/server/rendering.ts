import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REMOTION_BROWSER_EXECUTABLE,
  REMOTION_CHROME_MODE,
  REMOTION_OFFTHREAD_VIDEO_THREADS,
  REMOTION_RENDER_CONCURRENCY,
  REMOTION_RENDER_PORT,
  RENDER_INTRO_MS,
  RUNTIME_CLIPS_DIR,
  RUNTIME_EXPORTS_DIR,
} from "@/lib/config";
import type { CaptionToken, ClipCandidate, ClipRenderProps, ClipSpan, RenderConfig, RenderFormat } from "@/lib/types";
import { createId, createStableHash, slugify, toFfmpegTimestamp } from "@/lib/utils";
import { rebaseTokensToSpans } from "./compaction";
import { fallbackEditDirectionPlan } from "./edit-direction";
import { getLatestEditDirectionPlan, getRun, listApprovedMediaRanges, listClipSpans, listRecentTokens, listSegments } from "./repository";
import { subtitleCuesForRenderProps } from "./subtitle-cues";
import { ensureDir } from "./fs";
import { runCommand, throwIfAborted } from "./process";
import { transcribeSegment } from "./transcription";

const VIDEO_FPS = 30;
const INTRO_SECONDS = RENDER_INTRO_MS / 1000;
const OUTRO_SECONDS = 5;
const TRANSITION_SECONDS = 0.6;
const CLIP_EXTRACTION_TIMEOUT_MS = 8 * 60_000;
const RENDER_CLIP_CACHE_VERSION = 5;
const clipExtractionPromises = new Map<string, Promise<string>>();
const KNOWN_SPLIT_WORDS = new Set(["nasdaq", "solana"]);
const MAX_CAPTION_SYNC_OFFSET_MS = 3_000;
const MIN_CAPTION_SYNC_OFFSET_MS = 80;
const MIN_CAPTION_SYNC_MATCHES = 4;
const SOURCE_AUDIO_VOLUME = 1.25;
const SOURCE_TAIL_PAD_MS = 400;
const CAPTION_AUDIO_TAIL_PAD_MS = 300;
const HIGH_QUALITY_VIDEO_BITRATE = "18M";
const HIGH_QUALITY_VIDEO_MAXRATE = "24M";

function normalizeCaptionText(text: string) {
  return text
    .replace(/[‘’‛`´]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\s*'\s*/g, "'")
    .trim();
}

function hasRenderableCaptionCharacter(text: string) {
  return /[A-Za-z0-9]/.test(text);
}

function isApostropheToken(text: string) {
  return /^'+$/.test(text);
}

function isLeadingApostropheFragment(text: string) {
  return /^'[A-Za-z0-9]+$/.test(text);
}

function isApostropheSuffix(text: string) {
  return /^(s|t|re|ve|ll|d|m|em|cause|n)$/i.test(text.replace(/^'+/, ""));
}

function mergeCaptionToken(left: CaptionToken, right: CaptionToken, separator = ""): CaptionToken {
  return {
    text: normalizeCaptionText(`${left.text}${separator}${right.text}`),
    startMs: left.startMs,
    endMs: Math.max(left.endMs, right.endMs),
  };
}

function normalizeCaptionTokens(captions: CaptionToken[]) {
  const merged: CaptionToken[] = [];

  for (let index = 0; index < captions.length; index += 1) {
    const caption = {
      ...captions[index],
      text: normalizeCaptionText(captions[index].text),
    };
    const previous = merged[merged.length - 1];
    const next = captions[index + 1]
      ? { ...captions[index + 1], text: normalizeCaptionText(captions[index + 1].text) }
      : null;

    if (previous && isApostropheToken(caption.text) && next && isApostropheSuffix(next.text)) {
      merged[merged.length - 1] = mergeCaptionToken(previous, next, "'");
      index += 1;
      continue;
    }

    if (previous && isLeadingApostropheFragment(caption.text) && isApostropheSuffix(caption.text)) {
      merged[merged.length - 1] = mergeCaptionToken(previous, caption);
      continue;
    }

    if (previous && KNOWN_SPLIT_WORDS.has(`${previous.text}${caption.text}`.toLowerCase())) {
      merged[merged.length - 1] = mergeCaptionToken(previous, caption);
      continue;
    }

    if (!hasRenderableCaptionCharacter(caption.text)) {
      continue;
    }

    merged.push(caption);
  }

  return merged;
}

async function hasVideoStream(filePath: string) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    return false;
  }

  const probe = await runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "csv=p=0",
    filePath,
  ], process.cwd(), { timeoutMs: 15_000 });

  return probe.exitCode === 0 && probe.stdout.trim().includes("video");
}

async function extractWithTranscode(input: {
  inputPath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  encoder: "h264_videotoolbox" | "libx264";
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const durationMs = Math.max(1, input.endMs - input.startMs);
  return runCommand("ffmpeg", [
    "-y",
    "-i",
    input.inputPath,
    "-ss",
    toFfmpegTimestamp(input.startMs),
    "-t",
    toFfmpegTimestamp(durationMs),
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    input.encoder,
    "-vf",
    `fps=${VIDEO_FPS},format=yuv420p`,
    "-b:v",
    HIGH_QUALITY_VIDEO_BITRATE,
    "-maxrate",
    HIGH_QUALITY_VIDEO_MAXRATE,
    ...(input.encoder === "libx264" ? ["-preset", "slow"] : []),
    "-pix_fmt",
    "yuv420p",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-avoid_negative_ts",
    "make_zero",
    "-movflags",
    "+faststart",
    input.outputPath,
  ], process.cwd(), {
    timeoutMs: CLIP_EXTRACTION_TIMEOUT_MS,
    signal: input.signal,
  });
}

async function trimSegmentClip(input: {
  inputPath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  if (fs.existsSync(input.outputPath)) {
    fs.rmSync(input.outputPath, { force: true });
  }

  const hardwareTranscode = await extractWithTranscode({
    ...input,
    encoder: "h264_videotoolbox",
  });
  if (hardwareTranscode.exitCode === 0 && (await hasVideoStream(input.outputPath))) {
    return;
  }

  const softwareTranscode = await extractWithTranscode({
    ...input,
    encoder: "libx264",
  });
  if (softwareTranscode.exitCode !== 0 || !(await hasVideoStream(input.outputPath))) {
    throw new Error(
      softwareTranscode.stderr ||
        hardwareTranscode.stderr ||
        "Failed to trim the approved clip from source segments.",
    );
  }
}

function collectCaptionTokens(runId: string, startMs: number, endMs: number): CaptionToken[] {
  return normalizeCaptionTokens(compactRemovedCaptionGaps(listRecentTokens(runId, startMs)
    .filter((token) => token.startMs <= endMs && token.endMs >= startMs)
    .map((token) => ({
      text: token.text,
      startMs: token.startMs - startMs,
      endMs: token.endMs - startMs,
      isRemoved: token.isRemoved || !token.text.trim(),
    }))));
}

function collectCompactedCaptionTokens(runId: string, candidate: ClipCandidate): CaptionToken[] {
  const spans = listClipSpans(candidate.id);
  return collectCaptionTokensForSpans(runId, candidate, spans);
}

function collectCaptionTokensForSpans(runId: string, candidate: ClipCandidate, spans: ClipSpan[]): CaptionToken[] {
  if (spans.length === 0) {
    return collectCaptionTokens(runId, candidate.suggestedStartMs, candidate.suggestedEndMs);
  }

  return normalizeCaptionTokens(compactRemovedCaptionGaps(rebaseTokensToSpans(
    listRecentTokens(runId, candidate.suggestedStartMs)
      .filter((token) => token.startMs <= candidate.suggestedEndMs && token.endMs >= candidate.suggestedStartMs),
    spans,
  )));
}

function compactRemovedCaptionGaps(tokens: Array<CaptionToken & { isRemoved?: boolean }>): CaptionToken[] {
  const compacted: CaptionToken[] = [];
  let shiftMs = 0;

  for (const token of tokens) {
    if (token.isRemoved || !token.text.trim()) {
      shiftMs += Math.max(0, token.endMs - token.startMs);
      continue;
    }

    const startMs = Math.max(0, token.startMs - shiftMs);
    const endMs = Math.max(startMs, token.endMs - shiftMs);
    compacted.push({ text: token.text, startMs, endMs });
  }

  return compacted;
}

function parseRenderClipSpans(clipSpansJson: string | null | undefined): ClipSpan[] {
  if (!clipSpansJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(clipSpansJson) as ClipSpan[] | { spans?: ClipSpan[] };
    const spans = Array.isArray(parsed) ? parsed : parsed.spans;
    if (!Array.isArray(spans)) {
      return [];
    }

    return spans
      .filter((span) =>
        Number.isFinite(span.sourceStartMs) &&
        Number.isFinite(span.sourceEndMs) &&
        Number.isFinite(span.outputStartMs) &&
        Number.isFinite(span.outputEndMs) &&
        span.sourceEndMs > span.sourceStartMs &&
        span.outputEndMs > span.outputStartMs
      )
      .sort((left, right) => left.outputStartMs - right.outputStartMs);
  } catch {
    return [];
  }
}

function clipDurationMs(candidate: ClipCandidate, spans: ClipSpan[]) {
  const approvedMs = spans.length > 0
    ? Math.max(...spans.map((span) => span.outputEndMs))
    : candidate.suggestedEndMs - candidate.suggestedStartMs;

  return approvedMs + SOURCE_TAIL_PAD_MS;
}

function extendClipSpansToCaptionTail(runId: string, candidate: ClipCandidate, spans: ClipSpan[]) {
  if (spans.length === 0) {
    return spans;
  }

  const captions = collectCaptionTokensForSpans(runId, candidate, spans);
  const lastCaptionEndMs = Math.max(0, ...captions.map((caption) => caption.endMs));
  const currentEndMs = Math.max(...spans.map((span) => span.outputEndMs));
  const targetEndMs = lastCaptionEndMs + CAPTION_AUDIO_TAIL_PAD_MS;
  if (targetEndMs <= currentEndMs) {
    return spans;
  }

  const extended = spans.map((span) => ({ ...span }));
  const lastSpan = extended.reduce((latest, span) =>
    span.outputEndMs > latest.outputEndMs ? span : latest,
  );
  const extensionMs = targetEndMs - lastSpan.outputEndMs;
  lastSpan.outputEndMs += extensionMs;
  lastSpan.sourceEndMs += extensionMs;
  return extended;
}

function normalizeAlignmentWord(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9']/g, "");
}

async function estimateCaptionTimingOffsetMs(input: {
  runId: string;
  candidate: ClipCandidate;
  clipPath: string;
  clipSpans?: ClipSpan[];
  signal?: AbortSignal;
}) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-caption-sync-"));
  try {
    const renderedTranscript = await transcribeSegment({
      runId: input.runId,
      segmentId: `caption_sync_${input.candidate.id}`,
      videoPath: input.clipPath,
      startOffsetMs: 0,
      outputDir,
      signal: input.signal,
    });
    const spans: ClipSpan[] = input.clipSpans && input.clipSpans.length > 0
      ? input.clipSpans
      : [{
          id: "caption_sync_fallback_span",
          candidateId: input.candidate.id,
          runId: input.runId,
          sourceStartMs: input.candidate.suggestedStartMs,
          sourceEndMs: input.candidate.suggestedEndMs,
          outputStartMs: 0,
          outputEndMs: input.candidate.suggestedEndMs - input.candidate.suggestedStartMs,
          reason: null,
          createdAt: new Date().toISOString(),
        }];
    const expectedTokens = spans.length > 0
      ? rebaseTokensToSpans(
          listRecentTokens(input.runId, Math.min(...spans.map((span) => span.sourceStartMs)))
            .filter((token) =>
              !token.isRemoved &&
              token.text.trim() &&
              spans.some((span) => token.startMs <= span.sourceEndMs && token.endMs >= span.sourceStartMs)
            ),
          spans,
        )
      : [];
    const expected = expectedTokens
      .map((token) => ({
        text: normalizeAlignmentWord(token.text),
        startMs: token.startMs,
      }))
      .filter((token) => token.text);
    const actual = renderedTranscript.tokens
      .map((token) => ({
        text: normalizeAlignmentWord(token.text),
        startMs: token.startMs,
      }))
      .filter((token) => token.text);

    const deltas: number[] = [];
    let cursor = 0;
    for (const expectedToken of expected) {
      for (let index = cursor; index < actual.length; index += 1) {
        if (actual[index].text === expectedToken.text) {
          deltas.push(actual[index].startMs - expectedToken.startMs);
          cursor = index + 1;
          break;
        }
      }
      if (deltas.length >= 80) break;
    }

    if (deltas.length < MIN_CAPTION_SYNC_MATCHES) {
      return 0;
    }

    const sorted = deltas.sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (Math.abs(median) < MIN_CAPTION_SYNC_OFFSET_MS || Math.abs(median) > MAX_CAPTION_SYNC_OFFSET_MS) {
      return 0;
    }

    return Math.round(median);
  } catch {
    return 0;
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function isRenderableVideoSegment(segment: ReturnType<typeof listSegments>[number]) {
  return segment.status === "processed" && segment.mediaType !== "audio" && fs.existsSync(segment.videoPath);
}

function findCoveringSegment(runId: string, startMs: number, endMs: number) {
  return listSegments(runId).find(
    (item) =>
      isRenderableVideoSegment(item) &&
      item.startMs <= startMs &&
      item.endMs >= endMs,
  );
}

async function extractClipFromSegments(input: {
  runId: string;
  candidate: ClipCandidate;
  clipSpans?: ClipSpan[];
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  ensureDir(RUNTIME_CLIPS_DIR);
  const cacheKey = [
    input.runId,
    input.candidate.id,
    input.candidate.suggestedStartMs,
    input.candidate.suggestedEndMs,
    input.clipSpans?.map((span) => `${span.sourceStartMs}-${span.sourceEndMs}-${span.outputStartMs}-${span.outputEndMs}`).join(",") ?? "",
    RENDER_CLIP_CACHE_VERSION,
  ].join(":");
  const spanSuffix = input.clipSpans && input.clipSpans.length > 0
    ? `spans-${createStableHash(input.clipSpans.map((span) => `${span.sourceStartMs}-${span.sourceEndMs}-${span.outputStartMs}-${span.outputEndMs}`).join("|"))}`
    : `${input.candidate.suggestedStartMs}-${input.candidate.suggestedEndMs}`;
  const mergedClipPath = path.join(
    RUNTIME_CLIPS_DIR,
    `${input.candidate.id}-${spanSuffix}-v${RENDER_CLIP_CACHE_VERSION}.mp4`,
  );

  if (fs.existsSync(mergedClipPath) && (await hasVideoStream(mergedClipPath))) {
    return mergedClipPath;
  }

  const activeExtraction = clipExtractionPromises.get(cacheKey);
  if (activeExtraction) {
    return activeExtraction;
  }

  const extraction = extractClipFromSegmentsUncached({
    ...input,
    outputPath: mergedClipPath,
  });
  clipExtractionPromises.set(cacheKey, extraction);

  try {
    return await extraction;
  } finally {
    clipExtractionPromises.delete(cacheKey);
  }
}

async function extractClipFromSegmentsUncached(input: {
  runId: string;
  candidate: ClipCandidate;
  clipSpans?: ClipSpan[];
  outputPath: string;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const spans = input.clipSpans && input.clipSpans.length > 0
    ? input.clipSpans
    : listClipSpans(input.candidate.id);
  const requestedStartMs = spans.length > 0
    ? Math.min(...spans.map((span) => span.sourceStartMs))
    : input.candidate.suggestedStartMs;
  const requestedEndMs = spans.length > 0
    ? Math.max(...spans.map((span) => span.sourceEndMs))
    : input.candidate.suggestedEndMs;
  if (spans.length > 1) {
    const tempDir = path.join(path.dirname(input.outputPath), "temp");
    ensureDir(tempDir);
    const trimmedFiles: string[] = [];
    const concatList = path.join(tempDir, `${input.candidate.id}-compact-concat.txt`);
    try {
      for (const [index, span] of spans.entries()) {
        const segment = findCoveringSegment(input.runId, span.sourceStartMs, span.sourceEndMs);
        const approvedRange = segment
          ? null
          : listApprovedMediaRanges(input.candidate.id).find(
          (range) =>
            fs.existsSync(range.videoPath) &&
            range.sourceStartMs <= span.sourceStartMs &&
            range.sourceEndMs >= span.sourceEndMs,
        );
        const sourcePath = approvedRange?.videoPath ?? segment?.videoPath;
        const sourceStartMs = approvedRange?.sourceStartMs ?? segment?.startMs;
        const sourceEndMs = approvedRange?.sourceEndMs ?? segment?.endMs;
        if (!sourcePath || sourceStartMs === undefined || sourceEndMs === undefined) {
          throw new Error("Available media does not cover every compacted clip span.");
        }

        const outputPath = path.join(tempDir, `${input.candidate.id}-compact-${index}.mp4`);
        const spanEndMs = index === spans.length - 1
          ? Math.min(span.sourceEndMs + SOURCE_TAIL_PAD_MS, sourceEndMs)
          : span.sourceEndMs;

        await trimSegmentClip({
          inputPath: sourcePath,
          outputPath,
          startMs: span.sourceStartMs - sourceStartMs,
          endMs: spanEndMs - sourceStartMs,
          signal: input.signal,
        });
        trimmedFiles.push(outputPath);
      }

      fs.writeFileSync(concatList, trimmedFiles.map((file) => `file '${file}'`).join("\n"));
      const merged = await runCommand("ffmpeg", [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatList,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        input.outputPath,
      ], process.cwd(), {
        timeoutMs: CLIP_EXTRACTION_TIMEOUT_MS,
        signal: input.signal,
      });
      if (merged.exitCode !== 0 || !(await hasVideoStream(input.outputPath))) {
        throw new Error(merged.stderr || "Failed to merge compacted clip spans.");
      }
      return input.outputPath;
    } finally {
      for (const file of [...trimmedFiles, concatList]) {
        if (fs.existsSync(file)) {
          fs.rmSync(file, { force: true });
        }
      }
    }
  }

  const fullCoveringSegment = findCoveringSegment(input.runId, requestedStartMs, requestedEndMs);
  if (fullCoveringSegment) {
    await trimSegmentClip({
      inputPath: fullCoveringSegment.videoPath,
      outputPath: input.outputPath,
      startMs: requestedStartMs - fullCoveringSegment.startMs,
      endMs: Math.min(requestedEndMs + SOURCE_TAIL_PAD_MS, fullCoveringSegment.endMs) - fullCoveringSegment.startMs,
      signal: input.signal,
    });
    return input.outputPath;
  }

  const approvedRanges = listApprovedMediaRanges(input.candidate.id)
    .filter((range) =>
      fs.existsSync(range.videoPath) &&
      range.sourceEndMs > requestedStartMs &&
      range.sourceStartMs < requestedEndMs
    );
  if (approvedRanges.length > 0) {
    const fullCover = approvedRanges.find(
      (range) =>
        range.sourceStartMs <= requestedStartMs &&
        range.sourceEndMs >= requestedEndMs,
    );
    if (fullCover) {
      await trimSegmentClip({
        inputPath: fullCover.videoPath,
        outputPath: input.outputPath,
        startMs: requestedStartMs - fullCover.sourceStartMs,
        endMs: Math.min(requestedEndMs + SOURCE_TAIL_PAD_MS, fullCover.sourceEndMs) - fullCover.sourceStartMs,
        signal: input.signal,
      });
      return input.outputPath;
    }
  }

  const segments = listSegments(input.runId).filter(
    (segment) =>
      segment.endMs > requestedStartMs &&
      segment.startMs < requestedEndMs &&
      isRenderableVideoSegment(segment),
  );

  if (segments.length === 0) {
    throw new Error("No approved media or processed source segments cover the approved clip range yet.");
  }

  const coverageStart = Math.min(...segments.map((segment) => segment.startMs));
  const coverageEnd = Math.max(...segments.map((segment) => segment.endMs));
  if (coverageStart > requestedStartMs || coverageEnd < requestedEndMs) {
    throw new Error("Available media does not cover the requested timestamp range.");
  }

  const tempDir = path.join(path.dirname(segments[0].videoPath), "..", "temp");
  ensureDir(tempDir);

  const trimmedFiles: string[] = [];
  const cleanupPaths: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const trimStartMs = Math.max(0, requestedStartMs - segment.startMs);
    const isLastSegment = segment.endMs >= requestedEndMs || index === segments.length - 1;
    const requestedSegmentEndMs = (isLastSegment ? requestedEndMs + SOURCE_TAIL_PAD_MS : requestedEndMs) - segment.startMs;
    const trimEndMs = Math.min(segment.endMs - segment.startMs, requestedSegmentEndMs);
    const outputPath = path.join(tempDir, `${input.candidate.id}-${index}.mp4`);

    await trimSegmentClip({
      inputPath: segment.videoPath,
      outputPath,
      startMs: trimStartMs,
      endMs: trimEndMs,
      signal: input.signal,
    });
    trimmedFiles.push(outputPath);
    cleanupPaths.push(outputPath);
  }

  if (fs.existsSync(input.outputPath)) {
    fs.rmSync(input.outputPath, { force: true });
  }
  if (trimmedFiles.length === 1) {
    fs.copyFileSync(trimmedFiles[0], input.outputPath);
    if (fs.existsSync(trimmedFiles[0])) {
      fs.rmSync(trimmedFiles[0], { force: true });
    }
    return input.outputPath;
  }

  const concatList = path.join(tempDir, `${input.candidate.id}-concat.txt`);
  fs.writeFileSync(concatList, trimmedFiles.map((file) => `file '${file}'`).join("\n"));
  cleanupPaths.push(concatList);

  try {
    const merged = await runCommand("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatList,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      input.outputPath,
    ], process.cwd(), {
      timeoutMs: 30_000,
      signal: input.signal,
    });

    if (merged.exitCode !== 0 || !(await hasVideoStream(input.outputPath))) {
      const fallbackMerged = await runCommand("ffmpeg", [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatList,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "h264_videotoolbox",
        "-b:v",
        "8M",
        "-maxrate",
        "10M",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        input.outputPath,
      ], process.cwd(), {
        timeoutMs: CLIP_EXTRACTION_TIMEOUT_MS,
        signal: input.signal,
      });

      if (fallbackMerged.exitCode !== 0 || !(await hasVideoStream(input.outputPath))) {
        const softwareMerged = await runCommand("ffmpeg", [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          concatList,
          "-map",
          "0:v:0",
          "-map",
          "0:a?",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          input.outputPath,
        ], process.cwd(), {
          timeoutMs: CLIP_EXTRACTION_TIMEOUT_MS,
          signal: input.signal,
        });

        if (softwareMerged.exitCode !== 0 || !(await hasVideoStream(input.outputPath))) {
          throw new Error(
            softwareMerged.stderr ||
              fallbackMerged.stderr ||
              merged.stderr ||
              "Failed to merge trimmed clip sections.",
          );
        }
      }
    }
  } finally {
    for (const cleanupPath of cleanupPaths) {
      if (fs.existsSync(cleanupPath)) {
        fs.rmSync(cleanupPath, { force: true });
      }
    }
  }

  return input.outputPath;
}

function buildRenderProps(input: {
  renderId?: string | null;
  runId: string;
  candidate: ClipCandidate;
  format: RenderFormat;
  clipPublicSrc: string;
  renderConfig: RenderConfig | null;
  captionTimingOffsetMs: number;
  clipSpans?: ClipSpan[];
}): ClipRenderProps {
  const captions = input.clipSpans && input.clipSpans.length > 0
    ? collectCaptionTokensForSpans(input.runId, input.candidate, input.clipSpans)
    : collectCompactedCaptionTokens(input.runId, input.candidate);
  const renderConfig = input.renderConfig;
  const clipMs = clipDurationMs(input.candidate, input.clipSpans ?? []);
  const clipFrames = Math.max(1, Math.ceil((clipMs / 1000) * VIDEO_FPS));
  const introFrames = INTRO_SECONDS * VIDEO_FPS;
  const outroFrames = renderConfig?.outroSrc ? OUTRO_SECONDS * VIDEO_FPS : 0;
  const transitionFrames = Math.min(
    Math.round(TRANSITION_SECONDS * VIDEO_FPS),
    Math.floor(introFrames / 2),
    Math.floor(clipFrames / 4),
  );
  const outroTransitionFrames = outroFrames > 0 ? transitionFrames : 0;
  const durationInFrames = introFrames + clipFrames + outroTransitionFrames + outroFrames;
  const captionFontSize =
    renderConfig?.captionSize === "sm"
      ? 40
      : renderConfig?.captionSize === "lg"
        ? 64
        : 52;

  const directionPlan = getLatestEditDirectionPlan(input.candidate.id)?.plan ??
    fallbackEditDirectionPlan({ candidate: input.candidate, renderConfig });
  const introMs = Math.round((introFrames / VIDEO_FPS) * 1000);

  return {
    format: input.format,
    videoSrc: input.clipPublicSrc,
    introSrc: renderConfig?.introSrc ?? null,
    outroSrc: renderConfig?.outroSrc ?? null,
    musicSrc: renderConfig?.musicSrc ?? null,
    musicPreset: renderConfig?.musicPreset ?? "balanced",
    musicVolume: renderConfig?.musicVolume ?? 0,
    musicFadeInFrames: renderConfig?.musicFadeIn === false ? 0 : 2 * VIDEO_FPS,
    musicFadeOutFrames: renderConfig?.musicFadeOut === false ? 0 : 2 * VIDEO_FPS,
    sourceAudioFadeOutFrames: 0,
    sourceAudioVolume: SOURCE_AUDIO_VOLUME,
    transitionFrames,
    durationInFrames,
    introFrames,
    clipFrames,
    captions,
    subtitleCues: input.renderId
      ? subtitleCuesForRenderProps(input.renderId, introMs).map((cue) => ({
          text: cue.text,
          startMs: cue.startMs,
          endMs: cue.endMs,
          isHidden: cue.isHidden,
        }))
      : [],
    captionTimingOffsetMs: input.captionTimingOffsetMs,
    title: input.candidate.title,
    hook: input.candidate.hook,
    captionStyle: renderConfig?.captionStyle ?? "pill",
    captionFontSize,
    captionColor: renderConfig?.captionColor ?? "#f4a60b",
    captionPlacement: renderConfig?.captionPlacement ?? "bottom",
    fontFamily: renderConfig?.fontFamily ?? "Archivo",
    fontSource: renderConfig?.fontSource ?? "google",
    subtitleMode: renderConfig?.subtitleMode ?? "phrase_1_4",
    videoFillMode:
      renderConfig?.videoFillMode ?? (input.format === "vertical" ? "blur" : "contain"),
    camera: renderConfig?.enableMotion === false ? [] : directionPlan.camera.map((beat) => ({
      startMs: beat.startMs,
      endMs: beat.endMs,
      preset: beat.preset,
      focusX: beat.focusX,
      focusY: beat.focusY,
      zoomFrom: beat.zoomFrom,
      zoomTo: beat.zoomTo,
      visualConfidence: beat.visualConfidence,
    })),
  };
}

export async function renderApprovedClip(input: {
  renderId?: string | null;
  runId: string;
  candidate: ClipCandidate;
  format: RenderFormat;
  renderConfig: RenderConfig | null;
  renderSignature: string | null;
  clipSpansJson?: string | null;
  onProgress?: (progressPercent: number) => void;
  signal?: AbortSignal;
}): Promise<{ outputPath: string; captionTimingOffsetMs: number }> {
  throwIfAborted(input.signal);
  ensureDir(RUNTIME_EXPORTS_DIR);
  const clipSpans = extendClipSpansToCaptionTail(
    input.runId,
    input.candidate,
    parseRenderClipSpans(input.clipSpansJson),
  );
  const mergedClipPath = await extractClipFromSegments({ ...input, clipSpans });
  const captionTimingOffsetMs = input.renderConfig?.enableCaptions === false
    ? 0
    : await estimateCaptionTimingOffsetMs({
        runId: input.runId,
        candidate: input.candidate,
        clipPath: mergedClipPath,
        clipSpans,
        signal: input.signal,
      });
  const run = getRun(input.runId);
  const streamFolderName = slugify(run?.label ?? input.runId);
  const streamFolder = path.join(RUNTIME_EXPORTS_DIR, streamFolderName);
  ensureDir(streamFolder);
  const baseName = slugify(input.renderConfig?.outputFileName ?? input.candidate.title ?? input.candidate.id);
  const outputFileName = `${baseName}-${input.format}${input.renderSignature ? `-${input.renderSignature}` : ""}.mp4`;
  const outputPath = path.join(streamFolder, outputFileName);
  const clipPublicSrc = `/runtime/clips/${path.basename(mergedClipPath)}`;
  const props = buildRenderProps({
    renderId: input.renderId,
    runId: input.runId,
    candidate: input.candidate,
    format: input.format,
    clipPublicSrc,
    renderConfig: input.renderConfig,
    captionTimingOffsetMs,
    clipSpans,
  });
  const propsFile = path.join(streamFolder, `${createId("props")}.json`);
  fs.writeFileSync(propsFile, JSON.stringify(props, null, 2));

  let latestProgress = 0;
  let result;
  const renderArgs = [
    "remotion",
    "render",
    "src/remotion/index.ts",
    "LiveClipComposition",
    outputPath,
    "--props",
    propsFile,
  ];

  if (REMOTION_RENDER_PORT !== null) {
    renderArgs.push(`--port=${REMOTION_RENDER_PORT}`);
  }

  renderArgs.push(
    `--browser-executable=${REMOTION_BROWSER_EXECUTABLE}`,
    `--chrome-mode=${REMOTION_CHROME_MODE}`,
    `--concurrency=${REMOTION_RENDER_CONCURRENCY}`,
    `--offthread-video-threads=${REMOTION_OFFTHREAD_VIDEO_THREADS}`,
    "--timeout=120000",
    "--disallow-parallel-encoding",
  );

  try {
    result = await runCommand("npx", [
      ...renderArgs,
    ], process.cwd(), {
      timeoutMs: 15 * 60_000,
      signal: input.signal,
      onStdoutLine: (line) => {
        const percentMatch = line.match(/(\d{1,3}(?:\.\d+)?)%/);
        if (!percentMatch) {
          return;
        }

        const parsed = Number(percentMatch[1]);
        if (!Number.isFinite(parsed)) {
          return;
        }

        latestProgress = Math.max(latestProgress, Math.min(99, parsed));
        input.onProgress?.(latestProgress);
      },
      onStderrLine: (line) => {
        const percentMatch = line.match(/(\d{1,3}(?:\.\d+)?)%/);
        if (!percentMatch) {
          return;
        }

        const parsed = Number(percentMatch[1]);
        if (!Number.isFinite(parsed)) {
          return;
        }

        latestProgress = Math.max(latestProgress, Math.min(99, parsed));
        input.onProgress?.(latestProgress);
      },
    });
  } finally {
    if (fs.existsSync(propsFile)) {
      fs.rmSync(propsFile, { force: true });
    }
  }

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "Remotion render failed.");
  }

  return { outputPath, captionTimingOffsetMs };
}
