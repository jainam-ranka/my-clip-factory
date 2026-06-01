import { z } from "zod";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { parseJsonBody } from "@/lib/server/http";
import { createRenderTemplate, listRenderTemplates } from "@/lib/server/repository";

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

export async function GET() {
  bootstrapServer();
  return Response.json({ templates: listRenderTemplates() });
}

export async function POST(request: Request) {
  bootstrapServer();
  const { data: payload, error } = await parseJsonBody(request, templateSchema);

  if (error) {
    return error;
  }

  const template = createRenderTemplate(payload);
  return Response.json({ template }, { status: 201 });
}
