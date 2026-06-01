import { z } from "zod";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { parseJsonBody } from "@/lib/server/http";
import { getMediaDurationMs } from "@/lib/server/ingestion";
import { getOrCreateSubtitleCues } from "@/lib/server/subtitle-cues";
import { getCandidate, getRenderJob, replaceSubtitleCues } from "@/lib/server/repository";

const cueSchema = z.object({
  text: z.string().max(220),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  isHidden: z.boolean().optional(),
  sourceTokenIds: z.array(z.string()).optional(),
});

const updateSchema = z.object({
  cues: z.array(cueSchema).max(300),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const render = getRenderJob(id);
  if (!render?.outputPath || render.status !== "rendered") {
    return Response.json({ error: "Rendered export not found." }, { status: 404 });
  }

  const candidate = getCandidate(render.candidateId);
  if (!candidate) {
    return Response.json({ error: "Candidate not found." }, { status: 404 });
  }

  return Response.json({
    render,
    candidate,
    cues: getOrCreateSubtitleCues(id),
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const render = getRenderJob(id);
  if (!render?.outputPath || render.status !== "rendered") {
    return Response.json({ error: "Rendered export not found." }, { status: 404 });
  }

  const { data: payload, error } = await parseJsonBody(request, updateSchema);
  if (error) {
    return error;
  }

  const durationMs = await getMediaDurationMs(render.outputPath);
  if (!durationMs) {
    return Response.json({ error: "Rendered video duration could not be read." }, { status: 400 });
  }

  const sorted = [...payload.cues].sort((left, right) => left.startMs - right.startMs);
  let previousVisibleEndMs = 0;
  for (const cue of sorted) {
    if (cue.endMs <= cue.startMs) {
      return Response.json({ error: "Every subtitle cue needs an end time after its start time." }, { status: 400 });
    }

    if (!cue.isHidden && !cue.text.trim()) {
      return Response.json({ error: "Visible subtitle cues cannot be blank." }, { status: 400 });
    }

    if (!cue.isHidden && cue.startMs < previousVisibleEndMs) {
      return Response.json({ error: "Visible subtitle cues cannot overlap." }, { status: 400 });
    }

    if (!cue.isHidden) {
      previousVisibleEndMs = cue.endMs;
    }

    if (cue.endMs > durationMs + 250) {
      return Response.json({ error: "Subtitle cue extends beyond the rendered video." }, { status: 400 });
    }
  }

  const cues = replaceSubtitleCues(
    id,
    sorted.map((cue) => ({
      candidateId: render.candidateId,
      runId: render.runId,
      text: cue.text.trim(),
      startMs: cue.startMs,
      endMs: cue.endMs,
      isHidden: cue.isHidden ?? false,
      sourceTokenIds: cue.sourceTokenIds ?? [],
      editSource: "user" as const,
    })),
  );

  return Response.json({ render, cues });
}
