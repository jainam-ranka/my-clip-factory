import fs from "node:fs";
import path from "node:path";
import type { ClipCandidate } from "@/lib/types";
import { toFfmpegTimestamp } from "@/lib/utils";
import { ensureRunDirectories } from "./fs";
import { runCommand, throwIfAborted } from "./process";
import { listApprovedMediaRanges, listSegments } from "./repository";

const MAX_VISUAL_EVIDENCE_FRAMES = 4;

function resolveVisualSource(input: { runId: string; candidate: ClipCandidate }) {
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
    return null;
  }

  return {
    path: segment.videoPath,
    startMs: input.candidate.suggestedStartMs - segment.startMs,
    endMs: input.candidate.suggestedEndMs - segment.startMs,
  };
}

export async function extractVisualEvidenceFrames(input: {
  runId: string;
  candidate: ClipCandidate;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const source = resolveVisualSource(input);
  if (!source) {
    return [];
  }

  const durationMs = Math.max(1, source.endMs - source.startMs);
  const frameCount = Math.min(MAX_VISUAL_EVIDENCE_FRAMES, Math.max(1, Math.floor(durationMs / 1500)));
  const tempDir = path.join(ensureRunDirectories(input.runId).temp, "direction-frames", input.candidate.id);
  fs.mkdirSync(tempDir, { recursive: true });

  const frames: string[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const offsetMs = source.startMs + Math.round((durationMs * (index + 1)) / (frameCount + 1));
    const outputPath = path.join(tempDir, `frame-${index}.jpg`);
    const result = await runCommand("ffmpeg", [
      "-y",
      "-ss",
      toFfmpegTimestamp(offsetMs),
      "-i",
      source.path,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:-2",
      "-q:v",
      "4",
      outputPath,
    ], process.cwd(), {
      timeoutMs: 30_000,
      signal: input.signal,
    });
    if (result.exitCode === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      frames.push(`data:image/jpeg;base64,${fs.readFileSync(outputPath).toString("base64")}`);
    }
  }

  return frames;
}
