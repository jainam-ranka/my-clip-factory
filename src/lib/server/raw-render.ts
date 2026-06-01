import fs from "node:fs";
import path from "node:path";
import { RUNTIME_EXPORTS_DIR } from "@/lib/config";
import type { ClipCandidate } from "@/lib/types";
import { createStableHash, slugify, toFfmpegTimestamp } from "@/lib/utils";
import { ensureDir } from "./fs";
import { runCommand, throwIfAborted } from "./process";
import { getRun, listApprovedMediaRanges, listSegments } from "./repository";

const RAW_EXTRACTION_TIMEOUT_MS = 8 * 60_000;

export function validateRawClipRange(input: { candidate: ClipCandidate }) {
  const durationMs = input.candidate.suggestedEndMs - input.candidate.suggestedStartMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Raw clip range is invalid.");
  }
}

async function hasUsableOutput(outputPath: string) {
  return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
}

function resolveRawSource(input: { runId: string; candidate: ClipCandidate }) {
  const approvedRange = listApprovedMediaRanges(input.candidate.id).find(
    (range) =>
      fs.existsSync(range.videoPath) &&
      range.sourceStartMs <= input.candidate.suggestedStartMs &&
      range.sourceEndMs >= input.candidate.suggestedEndMs,
  );
  if (approvedRange) {
    return {
      path: approvedRange.videoPath,
      startMs: input.candidate.suggestedStartMs - approvedRange.sourceStartMs,
      endMs: input.candidate.suggestedEndMs - approvedRange.sourceStartMs,
    };
  }

  const segment = listSegments(input.runId).find(
    (item) =>
      item.status === "processed" &&
      item.mediaType !== "audio" &&
      fs.existsSync(item.videoPath) &&
      item.startMs <= input.candidate.suggestedStartMs &&
      item.endMs >= input.candidate.suggestedEndMs,
  );
  if (!segment) {
    throw new Error("No source media covers the raw clip range.");
  }

  return {
    path: segment.videoPath,
    startMs: input.candidate.suggestedStartMs - segment.startMs,
    endMs: input.candidate.suggestedEndMs - segment.startMs,
  };
}

export async function extractRawClip(input: {
  runId: string;
  candidate: ClipCandidate;
  renderSignature: string | null;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  validateRawClipRange({ candidate: input.candidate });

  const run = getRun(input.runId);
  const streamFolder = path.join(RUNTIME_EXPORTS_DIR, slugify(run?.label ?? input.runId));
  ensureDir(streamFolder);
  const signature = input.renderSignature ?? createStableHash(`${input.candidate.id}:raw`);
  const outputPath = path.join(streamFolder, `${slugify(input.candidate.title)}-raw-${signature}.mp4`);
  if (await hasUsableOutput(outputPath)) {
    return outputPath;
  }

  const source = resolveRawSource(input);
  const streamCopy = await runCommand("ffmpeg", [
    "-y",
    "-ss",
    toFfmpegTimestamp(source.startMs),
    "-to",
    toFfmpegTimestamp(source.endMs),
    "-i",
    source.path,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    "-movflags",
    "+faststart",
    outputPath,
  ], process.cwd(), {
    timeoutMs: RAW_EXTRACTION_TIMEOUT_MS,
    signal: input.signal,
  });

  if (streamCopy.exitCode === 0 && await hasUsableOutput(outputPath)) {
    return outputPath;
  }

  const fallback = await runCommand("ffmpeg", [
    "-y",
    "-ss",
    toFfmpegTimestamp(source.startMs),
    "-to",
    toFfmpegTimestamp(source.endMs),
    "-i",
    source.path,
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
    outputPath,
  ], process.cwd(), {
    timeoutMs: RAW_EXTRACTION_TIMEOUT_MS,
    signal: input.signal,
  });

  if (fallback.exitCode !== 0 || !(await hasUsableOutput(outputPath))) {
    throw new Error(fallback.stderr || streamCopy.stderr || "Raw clip extraction failed.");
  }

  return outputPath;
}
