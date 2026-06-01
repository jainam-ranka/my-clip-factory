import { z } from "zod";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { parseJsonBody } from "@/lib/server/http";
import { getCandidate, getRenderTemplate, setCandidateRenderConfig, setCandidateStatus } from "@/lib/server/repository";
import { prepareApprovedCandidateForRender, queueCandidateForRenderWithFormats } from "@/lib/server/runtime";

const approveSchema = z.object({
  templateId: z.string().trim().min(1),
  introSrc: z.string().trim().min(1).nullable().optional(),
  formats: z.array(z.enum(["vertical", "landscape"])).min(1).max(2).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const { data: payload, error } = await parseJsonBody(request, approveSchema);

  if (error) {
    return error;
  }

  const candidate = getCandidate(id);

  if (!candidate) {
    return Response.json({ error: "Candidate not found." }, { status: 404 });
  }

  const template = getRenderTemplate(payload.templateId);
  if (!template) {
    return Response.json({ error: "Template not found." }, { status: 404 });
  }

  setCandidateRenderConfig(id, {
    templateId: template.id,
    templateName: template.name,
    mode: template.mode,
    aiMotionEnabled: template.mode === "raw" ? false : template.aiMotionEnabled,
    motionIntensity: template.mode === "raw" ? "none" : template.motionIntensity,
    allowPunchIns: template.mode === "raw" ? false : template.allowPunchIns,
    maxMotionEvents: template.mode === "raw" ? 0 : template.maxMotionEvents,
    enableCaptions: template.mode === "raw" ? false : template.enableCaptions,
    enableMotion: template.mode === "raw" ? false : template.enableMotion,
    enableColor: template.mode === "raw" ? false : template.enableColor,
    enableMusic: template.mode === "raw" ? false : template.enableMusic,
    enableCompaction: template.mode === "raw" ? false : template.enableCompaction,
    colorGradePreset: template.colorGradePreset,
    aiMusicEnabled: template.mode === "raw" ? false : template.aiMusicEnabled,
    introSrc: payload.introSrc ?? candidate.renderConfig?.introSrc ?? template.introSrc,
    outroSrc: template.outroSrc,
    musicSrc: template.mode === "raw" ? null : template.musicSrc,
    musicPreset: "balanced",
    musicVolume: template.musicVolume,
    musicFadeIn: template.musicFadeIn,
    musicFadeOut: template.musicFadeOut,
    captionStyle: template.captionStyle,
    captionSize: template.captionSize,
    captionColor: template.captionColor,
    captionPlacement: template.captionPlacement,
    fontFamily: template.fontFamily,
    fontSource: template.fontSource,
    subtitleMode: template.subtitleMode,
    outputFileName: null,
    videoLayout: template.videoLayout,
    videoFillMode: template.videoFillMode,
  });

  setCandidateStatus(id, "approved");
  await prepareApprovedCandidateForRender(id);
  const approved = getCandidate(id);
  const renderJobs = queueCandidateForRenderWithFormats(id, payload.formats ?? [template.videoLayout]);
  return Response.json({ candidate: approved, renderJobs });
}
