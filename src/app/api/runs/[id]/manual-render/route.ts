import { z } from "zod";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { parseJsonBody } from "@/lib/server/http";
import { createManualRender } from "@/lib/server/runtime";

const manualRenderSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  title: z.string().trim().min(1).max(120).optional(),
  hook: z.string().trim().min(1).max(160).optional(),
  introSrc: z.string().trim().min(1).nullable().optional(),
  formats: z.array(z.enum(["vertical", "landscape"])).min(1).max(2).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const { data: payload, error } = await parseJsonBody(request, manualRenderSchema);

  if (error) {
    return error;
  }

  if (payload.endMs <= payload.startMs) {
    return Response.json({ error: "End timestamp must be after the start timestamp." }, { status: 400 });
  }

  try {
    const result = await createManualRender({
      runId: id,
      ...payload,
    });

    return Response.json(result, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Manual render failed." },
      { status: 400 },
    );
  }
}
