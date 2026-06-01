import { z } from "zod";
import { MAX_CLIP_MS, MIN_CLIP_MS } from "@/lib/config";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { parseJsonBody } from "@/lib/server/http";
import {
  getCandidate,
  getRunDetail,
  replaceClipSpans,
  updateCandidateCopy,
  updateCandidateWindow,
} from "@/lib/server/repository";

const updateCandidateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  hook: z.string().trim().min(1).max(220).optional(),
  suggestedStartMs: z.number().int().min(0).optional(),
  suggestedEndMs: z.number().int().min(1).optional(),
  clipSpans: z.array(z.object({
    sourceStartMs: z.number().int().min(0),
    sourceEndMs: z.number().int().min(1),
  })).max(12).optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const candidate = getCandidate(id);

  if (!candidate) {
    return Response.json({ error: "Candidate not found." }, { status: 404 });
  }

  const { data: payload, error } = await parseJsonBody(request, updateCandidateSchema);

  if (error) {
    return error;
  }

  if (
    !payload.title &&
    !payload.hook &&
    payload.suggestedStartMs === undefined &&
    payload.suggestedEndMs === undefined &&
    payload.clipSpans === undefined
  ) {
    return Response.json({ error: "Nothing to update." }, { status: 400 });
  }

  if (
    payload.suggestedStartMs !== undefined ||
    payload.suggestedEndMs !== undefined
  ) {
    const nextStartMs = payload.suggestedStartMs ?? candidate.suggestedStartMs;
    const nextEndMs = payload.suggestedEndMs ?? candidate.suggestedEndMs;
    const durationMs = nextEndMs - nextStartMs;

    if (nextEndMs <= nextStartMs) {
      return Response.json({ error: "Clip range is no longer valid." }, { status: 400 });
    }

    if (durationMs < MIN_CLIP_MS || durationMs > MAX_CLIP_MS) {
      return Response.json({
        error: `Clip range must stay between ${Math.round(MIN_CLIP_MS / 1000)} and ${Math.round(MAX_CLIP_MS / 1000)} seconds.`,
      }, { status: 400 });
    }

    const run = getRunDetail(candidate.runId);
    if (!run || nextEndMs > run.capturedMediaMs) {
      return Response.json({ error: "Clip range extends beyond captured media." }, { status: 400 });
    }
  }

  if (payload.clipSpans !== undefined) {
    const run = getRunDetail(candidate.runId);
    if (!run) {
      return Response.json({ error: "Run not found." }, { status: 404 });
    }

    let outputCursor = 0;
    const normalizedSpans = [...payload.clipSpans]
      .sort((left, right) => left.sourceStartMs - right.sourceStartMs)
      .map((span) => {
        const durationMs = span.sourceEndMs - span.sourceStartMs;
        if (durationMs <= 0) {
          return null;
        }
        if (
          span.sourceStartMs < candidate.suggestedStartMs ||
          span.sourceEndMs > candidate.suggestedEndMs ||
          span.sourceEndMs > run.capturedMediaMs
        ) {
          return null;
        }

        const nextSpan = {
          runId: candidate.runId,
          sourceStartMs: span.sourceStartMs,
          sourceEndMs: span.sourceEndMs,
          outputStartMs: outputCursor,
          outputEndMs: outputCursor + durationMs,
          reason: "manual multi-clip segment",
        };
        outputCursor += durationMs;
        return nextSpan;
      });

    if (normalizedSpans.some((span) => span === null)) {
      return Response.json({ error: "Every segment must be inside the candidate range and captured media." }, { status: 400 });
    }

    const totalDurationMs = outputCursor;
    if (normalizedSpans.length > 0 && (totalDurationMs < MIN_CLIP_MS || totalDurationMs > MAX_CLIP_MS)) {
      return Response.json({
        error: `Multi-clip duration must stay between ${Math.round(MIN_CLIP_MS / 1000)} and ${Math.round(MAX_CLIP_MS / 1000)} seconds.`,
      }, { status: 400 });
    }

    replaceClipSpans(id, normalizedSpans.filter((span): span is NonNullable<typeof span> => span !== null));
  }

  let updated = candidate;

  if (payload.title || payload.hook) {
    updated = updateCandidateCopy(id, payload) ?? updated;
  }

  if (payload.suggestedStartMs !== undefined || payload.suggestedEndMs !== undefined) {
    updated = updateCandidateWindow(id, payload) ?? updated;
    replaceClipSpans(id, []);
  }

  if (payload.clipSpans !== undefined) {
    const run = getRunDetail(candidate.runId);
    updated = run?.candidates.find((item) => item.id === id) ?? updated;
  }

  return Response.json({ candidate: updated });
}
