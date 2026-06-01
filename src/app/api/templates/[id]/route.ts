import { z } from "zod";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { parseJsonBody } from "@/lib/server/http";
import { deleteRenderTemplate, getRenderTemplate, updateRenderTemplate } from "@/lib/server/repository";

const templateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  mode: z.enum(["edited", "raw"]).default("edited"),
  aiMotionEnabled: z.boolean().default(true),
  motionIntensity: z.enum(["none", "subtle", "moderate"]).default("subtle"),
  allowPunchIns: z.boolean().default(true),
  maxMotionEvents: z.number().int().min(0).max(24).default(4),
  enableCaptions: z.boolean().default(true),
  enableMotion: z.boolean().default(true),
  enableColor: z.boolean().default(true),
  enableMusic: z.boolean().default(false),
  enableCompaction: z.boolean().default(true),
  colorGradePreset: z.enum(["neutral"]).default("neutral"),
  aiMusicEnabled: z.boolean().default(false),
  introSrc: z.string().trim().min(1).nullable(),
  musicSrc: z.string().trim().min(1).nullable(),
  captionStyle: z.enum(["pill", "minimal", "mono"]),
  captionSize: z.enum(["sm", "md", "lg"]),
  captionColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  captionPlacement: z.enum(["top", "middle", "bottom"]),
  musicVolume: z.number().min(0).max(100),
  musicFadeIn: z.boolean(),
  musicFadeOut: z.boolean(),
  outroSrc: z.string().trim().min(1).nullable(),
  videoLayout: z.enum(["vertical", "landscape"]),
  videoFillMode: z.enum(["cover", "contain", "blur"]),
  fontFamily: z.string().trim().min(1).max(80).default("Archivo"),
  fontSource: z.enum(["google", "system"]).default("google"),
  subtitleMode: z.enum(["one_word", "phrase_1_4"]).default("phrase_1_4"),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const existing = getRenderTemplate(id);

  if (!existing) {
    return Response.json({ error: "Template not found." }, { status: 404 });
  }

  const { data: payload, error } = await parseJsonBody(request, templateSchema);

  if (error) {
    return error;
  }

  const template = updateRenderTemplate(id, payload);
  return Response.json({ template });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const existing = getRenderTemplate(id);

  if (!existing) {
    return Response.json({ error: "Template not found." }, { status: 404 });
  }

  deleteRenderTemplate(id);
  return Response.json({ ok: true });
}
