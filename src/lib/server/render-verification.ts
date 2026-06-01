import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RENDER_INTRO_MS } from "@/lib/config";
import type { ClipCandidate, ClipSpan, RenderJob, TranscriptToken } from "@/lib/types";
import { getMediaDurationMs } from "./ingestion";
import { listRecentTokens } from "./repository";
import { transcribeSegment } from "./transcription";

const MIN_WORDS_FOR_TRANSCRIPT_CHECK = 4;
const MIN_ORDER_SCORE = 0.72;
const MAX_RENDERED_WORD_RATIO_FOR_REPEAT_CHECK = 1.25;
const VIDEO_FPS = 30;
const INTRO_SECONDS = RENDER_INTRO_MS / 1000;
const OUTRO_SECONDS = 5;
const TRANSITION_SECONDS = 0.6;
const SOURCE_TAIL_PAD_MS = 400;

function normalizeWord(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function meaningfulWords(tokens: TranscriptToken[]) {
  return tokens
    .filter((token) => !token.isRemoved)
    .map((token) => normalizeWord(token.text))
    .filter((word) => word.length > 0);
}

function parseClipSpans(render: RenderJob, candidate: ClipCandidate): ClipSpan[] {
  if (render.clipSpansJson) {
    try {
      const parsed = JSON.parse(render.clipSpansJson) as ClipSpan[] | { spans?: ClipSpan[] };
      const spans = Array.isArray(parsed) ? parsed : parsed.spans;
      if (Array.isArray(spans) && spans.length > 0) {
        return spans;
      }
    } catch {
      // Fall through to the candidate window.
    }
  }

  return [{
    id: "verification_fallback_span",
    candidateId: candidate.id,
    runId: candidate.runId,
    sourceStartMs: candidate.suggestedStartMs,
    sourceEndMs: candidate.suggestedEndMs,
    outputStartMs: 0,
    outputEndMs: candidate.suggestedEndMs - candidate.suggestedStartMs,
    reason: null,
    createdAt: new Date().toISOString(),
  }];
}

function expectedTokensForSpans(runId: string, spans: ClipSpan[]) {
  const startMs = Math.max(0, Math.min(...spans.map((span) => span.sourceStartMs)));
  const tokens = listRecentTokens(runId, startMs);

  return spans.flatMap((span) =>
    tokens.filter((token) =>
      token.endMs >= span.sourceStartMs &&
      token.startMs <= span.sourceEndMs &&
      !token.isRemoved,
    ),
  );
}

function lcsLength(left: string[], right: string[]) {
  const previous = Array(right.length + 1).fill(0) as number[];
  const current = Array(right.length + 1).fill(0) as number[];

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? previous[rightIndex - 1] + 1
        : Math.max(previous[rightIndex], current[rightIndex - 1]);
    }
    previous.splice(0, previous.length, ...current);
    current.fill(0);
  }

  return previous[right.length] ?? 0;
}

function countRepeatedFourGrams(words: string[]) {
  const counts = new Map<string, number>();
  for (let index = 0; index <= words.length - 4; index += 1) {
    const gram = words.slice(index, index + 4).join(" ");
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  return Array.from(counts.values()).filter((count) => count > 1).length;
}

function verifyTranscript(expectedWords: string[], renderedWords: string[]) {
  if (expectedWords.length < MIN_WORDS_FOR_TRANSCRIPT_CHECK) {
    return;
  }

  if (renderedWords.length < MIN_WORDS_FOR_TRANSCRIPT_CHECK) {
    throw new Error("Render verification failed: rendered transcript is empty or too short.");
  }

  const matched = lcsLength(expectedWords, renderedWords);
  const orderScore = matched / expectedWords.length;
  if (orderScore < MIN_ORDER_SCORE) {
    throw new Error(`Render verification failed: transcript order score ${orderScore.toFixed(2)} is below ${MIN_ORDER_SCORE}.`);
  }

  const expectedRepeats = countRepeatedFourGrams(expectedWords);
  const renderedRepeats = countRepeatedFourGrams(renderedWords);
  if (
    renderedWords.length > expectedWords.length * MAX_RENDERED_WORD_RATIO_FOR_REPEAT_CHECK &&
    renderedRepeats > expectedRepeats + 1
  ) {
    throw new Error("Render verification failed: rendered transcript has unexpected repeated phrases.");
  }
}

function expectedRenderDurationMs(candidate: ClipCandidate, render: RenderJob) {
  const spans = parseClipSpans(render, candidate);
  const clipMs = Math.max(
    1,
    spans.length > 0
      ? Math.max(...spans.map((span) => span.outputEndMs))
      : candidate.suggestedEndMs - candidate.suggestedStartMs,
  ) + SOURCE_TAIL_PAD_MS;
  const clipFrames = Math.max(1, Math.ceil((clipMs / 1000) * VIDEO_FPS));
  const introFrames = INTRO_SECONDS * VIDEO_FPS;
  const outroFrames = render.renderConfig?.outroSrc ? OUTRO_SECONDS * VIDEO_FPS : 0;
  const transitionFrames = Math.min(
    Math.round(TRANSITION_SECONDS * VIDEO_FPS),
    Math.floor(introFrames / 2),
    Math.floor(clipFrames / 4),
  );
  const outroTransitionFrames = outroFrames > 0 ? transitionFrames : 0;
  return Math.round(((introFrames + clipFrames + outroTransitionFrames + outroFrames) / VIDEO_FPS) * 1000);
}

export async function verifyRenderedClip(input: {
  render: RenderJob;
  candidate: ClipCandidate;
  outputPath: string;
  signal?: AbortSignal;
}) {
  const durationMs = await getMediaDurationMs(input.outputPath);
  if (!durationMs) {
    throw new Error("Render verification failed: rendered file has no readable duration.");
  }

  const spans = parseClipSpans(input.render, input.candidate);
  const expectedDurationMs = expectedRenderDurationMs(input.candidate, input.render);
  const durationToleranceMs = Math.max(1_500, Math.round(expectedDurationMs * 0.15));
  if (Math.abs(durationMs - expectedDurationMs) > durationToleranceMs) {
    throw new Error(
      `Render verification failed: duration ${durationMs}ms does not match expected ${expectedDurationMs}ms.`,
    );
  }

  const expectedWords = meaningfulWords(expectedTokensForSpans(input.render.runId, spans));
  if (expectedWords.length < MIN_WORDS_FOR_TRANSCRIPT_CHECK) {
    return;
  }

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-factory-render-verify-"));
  try {
    const transcript = await transcribeSegment({
      runId: input.render.runId,
      segmentId: `verify_${input.render.id}`,
      videoPath: input.outputPath,
      startOffsetMs: 0,
      outputDir,
      signal: input.signal,
    });
    verifyTranscript(expectedWords, meaningfulWords(transcript.tokens));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}
