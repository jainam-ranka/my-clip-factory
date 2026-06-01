import { z } from "zod";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { parseJsonBody } from "@/lib/server/http";
import { getRunDetail, setRunAutoApprove } from "@/lib/server/repository";

const updateRunSchema = z.object({
  autoApproveClips: z.boolean().optional(),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const detail = getRunDetail(id);

  if (!detail) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  return Response.json({ run: detail });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const { data: payload, error } = await parseJsonBody(request, updateRunSchema);

  if (error) {
    return error;
  }

  const detail = getRunDetail(id);

  if (!detail) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  if (payload.autoApproveClips !== undefined) {
    setRunAutoApprove(id, payload.autoApproveClips);
  }

  return Response.json({ run: getRunDetail(id) });
}
