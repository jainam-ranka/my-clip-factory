import {
  ENABLE_COMPACTED_RENDERING,
  FILLER_REMOVAL_MODE,
  MIN_KEEP_SPAN_MS,
  MIN_SAFE_CUT_SILENCE_MS,
} from "@/lib/config";
import type { ClipCandidate, ClipSpan, TranscriptToken } from "@/lib/types";

const SINGLE_WORD_FILLERS = new Set(["um", "uh", "erm", "ah"]);
const PHRASE_FILLERS = new Set(["you know", "i mean"]);

function cleanWord(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

export function isFillerToken(token: TranscriptToken, previous?: TranscriptToken | null, next?: TranscriptToken | null) {
  const word = cleanWord(token.text);
  if (!word) return false;
  if (SINGLE_WORD_FILLERS.has(word)) return true;
  if (previous && cleanWord(previous.text) === word) return true;
  if (next && PHRASE_FILLERS.has(`${word} ${cleanWord(next.text)}`)) return true;
  if (previous && PHRASE_FILLERS.has(`${cleanWord(previous.text)} ${word}`)) return true;
  return false;
}

export function buildConservativeClipSpans(input: {
  candidate: ClipCandidate;
  tokens: TranscriptToken[];
}) {
  const { candidate } = input;
  if (!ENABLE_COMPACTED_RENDERING || FILLER_REMOVAL_MODE !== "conservative") {
    return [{
      runId: candidate.runId,
      sourceStartMs: candidate.suggestedStartMs,
      sourceEndMs: candidate.suggestedEndMs,
      outputStartMs: 0,
      outputEndMs: candidate.suggestedEndMs - candidate.suggestedStartMs,
      reason: "continuous",
    }];
  }

  const tokens = input.tokens
    .filter((token) => token.endMs > candidate.suggestedStartMs && token.startMs < candidate.suggestedEndMs)
    .sort((left, right) => left.startMs - right.startMs);
  const cuts: Array<{ startMs: number; endMs: number; reason: string }> = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1] ?? null;
    const next = tokens[index + 1] ?? null;
    if (!isFillerToken(token, previous, next) || !previous || !next) {
      continue;
    }

    const beforeGap = token.startMs - previous.endMs;
    const afterGap = next.startMs - token.endMs;
    if (beforeGap < MIN_SAFE_CUT_SILENCE_MS || afterGap < MIN_SAFE_CUT_SILENCE_MS) {
      continue;
    }

    const cutStartMs = previous.endMs;
    const cutEndMs = next.startMs;
    const beforeDuration = cutStartMs - candidate.suggestedStartMs;
    const afterDuration = candidate.suggestedEndMs - cutEndMs;
    if (beforeDuration < MIN_KEEP_SPAN_MS || afterDuration < MIN_KEEP_SPAN_MS) {
      continue;
    }

    cuts.push({ startMs: cutStartMs, endMs: cutEndMs, reason: `removed filler: ${token.text}` });
  }

  if (cuts.length === 0) {
    return [{
      runId: candidate.runId,
      sourceStartMs: candidate.suggestedStartMs,
      sourceEndMs: candidate.suggestedEndMs,
      outputStartMs: 0,
      outputEndMs: candidate.suggestedEndMs - candidate.suggestedStartMs,
      reason: "continuous",
    }];
  }

  const spans: Omit<ClipSpan, "id" | "candidateId" | "createdAt">[] = [];
  let cursor = candidate.suggestedStartMs;
  let outputCursor = 0;
  for (const cut of cuts) {
    if (cut.startMs > cursor) {
      const duration = cut.startMs - cursor;
      spans.push({
        runId: candidate.runId,
        sourceStartMs: cursor,
        sourceEndMs: cut.startMs,
        outputStartMs: outputCursor,
        outputEndMs: outputCursor + duration,
        reason: cut.reason,
      });
      outputCursor += duration;
    }
    cursor = Math.max(cursor, cut.endMs);
  }

  if (cursor < candidate.suggestedEndMs) {
    const duration = candidate.suggestedEndMs - cursor;
    spans.push({
      runId: candidate.runId,
      sourceStartMs: cursor,
      sourceEndMs: candidate.suggestedEndMs,
      outputStartMs: outputCursor,
      outputEndMs: outputCursor + duration,
      reason: "tail",
    });
  }

  return spans.length > 0 ? spans : [{
    runId: candidate.runId,
    sourceStartMs: candidate.suggestedStartMs,
    sourceEndMs: candidate.suggestedEndMs,
    outputStartMs: 0,
    outputEndMs: candidate.suggestedEndMs - candidate.suggestedStartMs,
    reason: "continuous",
  }];
}

export function rebaseTokensToSpans(tokens: TranscriptToken[], spans: ClipSpan[]) {
  return tokens.flatMap((token) => {
    const span = spans.find((item) => token.startMs >= item.sourceStartMs && token.endMs <= item.sourceEndMs);
    if (!span) return [];
    return [{
      id: token.id,
      text: token.text,
      startMs: span.outputStartMs + token.startMs - span.sourceStartMs,
      endMs: span.outputStartMs + token.endMs - span.sourceStartMs,
      isRemoved: token.isRemoved,
      sourceTokenIds: [token.id],
    }];
  });
}
