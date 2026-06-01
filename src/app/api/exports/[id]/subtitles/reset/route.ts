import { bootstrapServer } from "@/lib/server/bootstrap";
import { getCandidate, getRenderJob } from "@/lib/server/repository";
import { generateSubtitleCuesForRender } from "@/lib/server/subtitle-cues";

export async function POST(
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
    cues: generateSubtitleCuesForRender(id) ?? [],
  });
}
