import OpenAI from "openai";
import {
  DEFAULT_OPENAI_MODEL,
  MAX_CLIP_MS,
  MIN_CLIP_MS,
} from "@/lib/config";
import type { AnalyzerDecision, TranscriptWindow } from "@/lib/types";
import { clamp } from "@/lib/utils";

function buildTranscript(window: TranscriptWindow) {
  return window.tokens
    .map((token) => `[${token.startMs}-${token.endMs}ms / ${(token.startMs / 1000).toFixed(1)}-${(token.endMs / 1000).toFixed(1)}s] ${token.text}`)
    .join(" ");
}

function normalizeTimestampUnit(value: unknown, window: TranscriptWindow): number | null {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  const windowEndSeconds = window.endedAtMs / 1000;
  const looksLikeSeconds =
    numericValue <= windowEndSeconds + 5 &&
    window.endedAtMs > 10_000;

  return Math.round(looksLikeSeconds ? numericValue * 1000 : numericValue);
}

function normalizeDecision(candidate: Partial<AnalyzerDecision>, window: TranscriptWindow): AnalyzerDecision {
  const end = window.tokens.at(-1)?.endMs ?? window.endedAtMs;
  const proposedStart =
    normalizeTimestampUnit(candidate.suggestedStart, window) ??
    Math.max(window.startedAtMs, end - 60_000);
  const proposedEnd =
    normalizeTimestampUnit(candidate.suggestedEnd, window) ??
    Math.min(end, proposedStart + 60_000);
  const clampedStart = Math.round(clamp(proposedStart, window.startedAtMs, Math.max(window.startedAtMs, end - MIN_CLIP_MS)));
  const clampedEnd = Math.round(clamp(proposedEnd, clampedStart + MIN_CLIP_MS, Math.min(end, clampedStart + MAX_CLIP_MS)));

  return {
    worthClipping: Boolean(candidate.worthClipping),
    reason: candidate.reason?.trim() || "No analysis reason returned.",
    confidence: clamp(Number(candidate.confidence ?? 0), 0, 1),
    suggestedStart: clampedStart,
    suggestedEnd: clampedEnd,
    title: candidate.title?.trim() || "Untitled clip",
    hook: candidate.hook?.trim() || "Interesting live moment",
    keywords: Array.isArray(candidate.keywords) ? candidate.keywords.slice(0, 6) : [],
  };
}

function unavailableDecision(window: TranscriptWindow, reason: string): AnalyzerDecision {
  const end = window.tokens.at(-1)?.endMs ?? window.endedAtMs;
  const start = clamp(end - MIN_CLIP_MS, window.startedAtMs, Math.max(window.startedAtMs, end - MIN_CLIP_MS));

  return {
    worthClipping: false,
    reason,
    confidence: 0,
    suggestedStart: start,
    suggestedEnd: Math.min(end, start + MIN_CLIP_MS),
    title: "AI analysis unavailable",
    hook: "No clip candidate created.",
    keywords: [],
  };
}

export async function analyzeTranscriptWindow(window: TranscriptWindow): Promise<AnalyzerDecision> {
  if (window.tokens.length < 30) {
    return {
      worthClipping: false,
      reason: "Not enough transcript context yet. Waiting for a fuller live window.",
      confidence: 0.1,
      suggestedStart: window.startedAtMs,
      suggestedEnd: Math.min(window.endedAtMs, window.startedAtMs + MIN_CLIP_MS),
      title: "Waiting for context",
      hook: "Not enough transcript yet",
      keywords: [],
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return unavailableDecision(window, "AI analysis unavailable because OPENAI_API_KEY is not configured.");
  }

  const client = new OpenAI({ apiKey });
  const transcript = buildTranscript(window);

  try {
    const response = await client.chat.completions.create({
      model: DEFAULT_OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You identify clip-worthy live moments. Return strict JSON with keys worthClipping, reason, confidence, suggestedStart, suggestedEnd, title, hook, keywords. suggestedStart and suggestedEnd must be absolute timestamps in milliseconds from the start of the source video, not seconds. Favor moments with surprise, strong opinion, punchline, announcement, conflict, or memorable insight. Include enough setup and payoff for the clip to stand alone. Prefer 30-75s clips, and never propose clips shorter than 20s or longer than 90s.",
        },
        {
          role: "user",
          content: JSON.stringify({
            windowStartMs: window.startedAtMs,
            windowEndMs: window.endedAtMs,
            transcript,
          }),
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as Partial<AnalyzerDecision>;
    return normalizeDecision(parsed, window);
  } catch (error) {
    console.warn(
      "AI clip analysis failed; no local fallback candidate will be created.",
      error instanceof Error ? error.message : error,
    );
    return unavailableDecision(window, "AI analysis failed. No local fallback candidate was created.");
  }
}
