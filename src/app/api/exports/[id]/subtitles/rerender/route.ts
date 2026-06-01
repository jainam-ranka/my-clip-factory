import { bootstrapServer } from "@/lib/server/bootstrap";
import {
  copySubtitleCues,
  createRenderJob,
  getRenderJob,
} from "@/lib/server/repository";
import { getOrCreateSubtitleCues } from "@/lib/server/subtitle-cues";
import { createStableHash } from "@/lib/utils";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const sourceRender = getRenderJob(id);
  if (!sourceRender?.outputPath || sourceRender.status !== "rendered") {
    return Response.json({ error: "Rendered export not found." }, { status: 404 });
  }

  const cues = getOrCreateSubtitleCues(id);
  const cueSignature = createStableHash(JSON.stringify(cues.map((cue) => ({
    text: cue.text,
    startMs: cue.startMs,
    endMs: cue.endMs,
    isHidden: cue.isHidden,
    sourceTokenIds: cue.sourceTokenIds,
  }))));
  const renderJob = createRenderJob({
    runId: sourceRender.runId,
    candidateId: sourceRender.candidateId,
    format: sourceRender.format,
    renderConfig: sourceRender.renderConfig,
    sourceStrategy: sourceRender.sourceStrategy,
    clipSpansJson: sourceRender.clipSpansJson,
    signatureSalt: `subtitle-rerender:${id}:${cueSignature}`,
  });

  if (!renderJob) {
    return Response.json({ error: "Could not create subtitle rerender job." }, { status: 400 });
  }

  copySubtitleCues(id, renderJob.id);
  return Response.json({ renderJob }, { status: 201 });
}
