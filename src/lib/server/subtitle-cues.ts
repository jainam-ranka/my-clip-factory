import type { ClipSpan, RenderJob, SubtitleCue } from "@/lib/types";
import { RENDER_INTRO_MS } from "@/lib/config";
import { buildTimedCaptionCues, type CaptionTokenWithSource, transcriptTokensToCaptionTokens } from "@/lib/subtitles";
import {
  getCandidate,
  getRenderJob,
  listRecentTokens,
  listSubtitleCues,
  replaceSubtitleCues,
} from "./repository";
import { rebaseTokensToSpans } from "./compaction";

function parseRenderClipSpans(render: RenderJob): ClipSpan[] {
  if (!render.clipSpansJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(render.clipSpansJson) as ClipSpan[] | { spans?: ClipSpan[] };
    const spans = Array.isArray(parsed) ? parsed : parsed.spans;
    return Array.isArray(spans) ? spans : [];
  } catch {
    return [];
  }
}

function renderIntroMs(render: RenderJob) {
  return render.renderConfig?.introSrc === null ? RENDER_INTRO_MS : RENDER_INTRO_MS;
}

function getRenderCaptionTokens(render: RenderJob): CaptionTokenWithSource[] {
  const candidate = getCandidate(render.candidateId);
  if (!candidate) {
    return [];
  }

  const spans = parseRenderClipSpans(render);
  if (spans.length > 0) {
    const tokens = listRecentTokens(render.runId, Math.min(...spans.map((span) => span.sourceStartMs)))
      .filter((token) =>
        token.startMs <= candidate.suggestedEndMs &&
        token.endMs >= candidate.suggestedStartMs,
      );
    return rebaseTokensToSpans(tokens, spans)
      .filter((token) => !token.isRemoved && token.text.trim())
      .map((token) => ({
        text: token.text,
        startMs: token.startMs,
        endMs: token.endMs,
        sourceTokenIds: token.sourceTokenIds ?? [token.id],
      }));
  }

  return transcriptTokensToCaptionTokens(
    listRecentTokens(render.runId, candidate.suggestedStartMs)
      .filter((token) => token.startMs <= candidate.suggestedEndMs && token.endMs >= candidate.suggestedStartMs),
  ).map((token) => ({
    ...token,
    startMs: token.startMs - candidate.suggestedStartMs,
    endMs: token.endMs - candidate.suggestedStartMs,
  }));
}

export function generateSubtitleCuesForRender(renderId: string) {
  const render = getRenderJob(renderId);
  if (!render) {
    return null;
  }

  const candidate = getCandidate(render.candidateId);
  if (!candidate) {
    return null;
  }

  const introMs = renderIntroMs(render);
  const captionTimingOffsetMs = render.captionTimingOffsetMs ?? 0;
  const generated = buildTimedCaptionCues(
    getRenderCaptionTokens(render),
    render.renderConfig?.subtitleMode ?? "phrase_1_4",
  ).map((cue) => ({
    candidateId: render.candidateId,
    runId: render.runId,
    text: cue.text,
    startMs: Math.max(0, Math.round(cue.startMs + introMs + captionTimingOffsetMs)),
    endMs: Math.max(0, Math.round(cue.endMs + introMs + captionTimingOffsetMs)),
    isHidden: false,
    sourceTokenIds: cue.sourceTokenIds,
    editSource: "generated" as const,
  }));

  return replaceSubtitleCues(render.id, generated);
}

export function getOrCreateSubtitleCues(renderId: string) {
  const existing = listSubtitleCues(renderId);
  if (existing.length > 0) {
    return existing;
  }

  return generateSubtitleCuesForRender(renderId) ?? [];
}

export function subtitleCuesForRenderProps(renderId: string, introMs: number): SubtitleCue[] {
  return listSubtitleCues(renderId)
    .filter((cue) => !cue.isHidden && cue.text.trim())
    .map((cue) => ({
      ...cue,
      startMs: Math.max(0, cue.startMs - introMs),
      endMs: Math.max(0, cue.endMs - introMs),
    }));
}
