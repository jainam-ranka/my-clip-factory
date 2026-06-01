import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ClipCandidate, ClipSpan, RenderJob } from "@/lib/types";
import { listApprovedMediaRanges, listSegments } from "./repository";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fcpxTime(ms: number) {
  return `${Math.max(0, Math.round(ms))}/1000s`;
}

function parseClipSpans(render: RenderJob, candidate: ClipCandidate): ClipSpan[] {
  if (render.clipSpansJson) {
    try {
      const parsed = JSON.parse(render.clipSpansJson) as ClipSpan[] | { spans?: ClipSpan[] };
      const spans = Array.isArray(parsed) ? parsed : parsed.spans;
      if (Array.isArray(spans) && spans.length > 0) {
        return spans;
      }
    } catch {
      // Fall through to the candidate range.
    }
  }

  return [{
    id: "davinci_fallback_span",
    candidateId: candidate.id,
    runId: candidate.runId,
    sourceStartMs: candidate.suggestedStartMs,
    sourceEndMs: candidate.suggestedEndMs,
    outputStartMs: 0,
    outputEndMs: candidate.suggestedEndMs - candidate.suggestedStartMs,
    reason: null,
    createdAt: new Date().toISOString(),
  }];
}

function resolveSpanMedia(candidate: ClipCandidate, span: ClipSpan) {
  const approvedRange = listApprovedMediaRanges(candidate.id).find(
    (range) =>
      fs.existsSync(range.videoPath) &&
      range.sourceStartMs <= span.sourceStartMs &&
      range.sourceEndMs >= span.sourceEndMs,
  );
  if (approvedRange) {
    return {
      path: approvedRange.videoPath,
      offsetMs: span.sourceStartMs - approvedRange.sourceStartMs,
      durationMs: span.sourceEndMs - span.sourceStartMs,
    };
  }

  const segment = listSegments(candidate.runId).find(
    (item) =>
      item.status === "processed" &&
      item.mediaType !== "audio" &&
      fs.existsSync(item.videoPath) &&
      item.startMs <= span.sourceStartMs &&
      item.endMs >= span.sourceEndMs,
  );
  if (!segment) {
    return null;
  }

  return {
    path: segment.videoPath,
    offsetMs: span.sourceStartMs - segment.startMs,
    durationMs: span.sourceEndMs - span.sourceStartMs,
  };
}

export function davinciSidecarPath(outputPath: string) {
  return outputPath.replace(/\.mp4$/i, ".fcpxml");
}

export function generateDavinciTimeline(input: {
  render: RenderJob;
  candidate: ClipCandidate;
  outputPath: string;
}) {
  const spans = parseClipSpans(input.render, input.candidate);
  const clips = spans
    .map((span) => ({ span, media: resolveSpanMedia(input.candidate, span) }))
    .filter((item): item is { span: ClipSpan; media: NonNullable<ReturnType<typeof resolveSpanMedia>> } =>
      item.media !== null,
    );

  if (clips.length === 0) {
    return null;
  }

  const assetIds = new Map<string, string>();
  const assets = clips.flatMap((clip) => {
    if (assetIds.has(clip.media.path)) {
      return [];
    }

    const id = `asset-${assetIds.size + 1}`;
    assetIds.set(clip.media.path, id);
    const name = path.basename(clip.media.path);
    return [
      `      <asset id="${id}" name="${escapeXml(name)}" start="0s" hasVideo="1" hasAudio="1" format="r1" src="${escapeXml(pathToFileURL(clip.media.path).href)}"/>`,
    ];
  });

  const timelineDurationMs = Math.max(...clips.map((clip) => clip.span.outputEndMs));
  const assetClips = clips.map((clip, index) => {
    const assetId = assetIds.get(clip.media.path);
    return [
      `          <asset-clip name="${escapeXml(`${input.candidate.title} ${index + 1}`)}" ref="${assetId}" offset="${fcpxTime(clip.span.outputStartMs)}" start="${fcpxTime(clip.media.offsetMs)}" duration="${fcpxTime(clip.media.durationMs)}"/>`,
    ].join("\n");
  });

  const timelineName = escapeXml(`${input.candidate.title} edit`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat1080p30" frameDuration="100/3000s" width="1920" height="1080"/>
${assets.join("\n")}
  </resources>
  <library>
    <event name="Clip Factory">
      <project name="${timelineName}">
        <sequence format="r1" duration="${fcpxTime(timelineDurationMs)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${assetClips.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;

  const sidecarPath = davinciSidecarPath(input.outputPath);
  fs.writeFileSync(sidecarPath, xml);
  return sidecarPath;
}
