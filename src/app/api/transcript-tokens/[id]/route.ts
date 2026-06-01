import { z } from "zod";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { parseJsonBody } from "@/lib/server/http";
import { updateTranscriptTokenText } from "@/lib/server/repository";

const schema = z.object({
  text: z.string().max(120),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const { data: payload, error } = await parseJsonBody(request, schema);

  if (error) {
    return error;
  }

  const token = updateTranscriptTokenText(id, payload.text);

  if (!token) {
    return Response.json({ error: "Transcript token not found." }, { status: 404 });
  }

  return Response.json({ token });
}
