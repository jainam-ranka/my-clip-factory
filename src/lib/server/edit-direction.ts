import {
  EDIT_DIRECTOR_MODEL,
  EDIT_DIRECTION_PROMPT_VERSION,
  EDIT_DIRECTION_SCHEMA_VERSION,
  ENABLE_GPT_DIRECTION,
  MAX_GPT_DIRECTION_CALLS_PER_CANDIDATE,
  MAX_TOTAL_DIRECTION_FRAMES,
} from "@/lib/config";
import type { ClipCandidate, RenderConfig, TranscriptToken } from "@/lib/types";
import OpenAI from "openai";

export type CameraPreset = "hold" | "slow_push" | "slow_pull" | "subtle_pan" | "punch_in";

export type FocusTarget =
  | "center"
  | "detected_face"
  | "detected_largest_face"
  | "manual_coordinates"
  | "slide_or_board"
  | "full_frame";

export type CameraBeat = {
  startMs: number;
  endMs: number;
  preset: CameraPreset;
  focus: FocusTarget;
  focusX: number;
  focusY: number;
  zoomFrom: number;
  zoomTo: number;
  visualConfidence: number;
  reason: string;
};

export type EditDirectionPlan = {
  version: 1;
  summary: string;
  camera: CameraBeat[];
  color: { preset: "neutral"; intensity: number };
  captions: { enabled: boolean };
  pacing: { style: "steady" | "tight" };
  music: { enabled: boolean; mood: "none" | "subtle" };
};

const CAMERA_PRESETS = new Set<CameraPreset>(["hold", "slow_push", "slow_pull", "subtle_pan", "punch_in"]);
const FOCUS_TARGETS = new Set<FocusTarget>([
  "center",
  "detected_face",
  "detected_largest_face",
  "manual_coordinates",
  "slide_or_board",
  "full_frame",
]);

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function motionEventCap(config: RenderConfig | null) {
  if (!config?.enableMotion || !config.aiMotionEnabled || config.motionIntensity === "none") {
    return 0;
  }
  return Math.max(0, Math.min(config.maxMotionEvents, MAX_TOTAL_DIRECTION_FRAMES));
}

function normalizeBeat(input: unknown, clipDurationMs: number, config: RenderConfig | null): CameraBeat | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const startMs = clampNumber(raw.startMs, 0, clipDurationMs, 0);
  const endMs = clampNumber(raw.endMs, startMs + 1, clipDurationMs, clipDurationMs);
  const visualConfidence = clampNumber(raw.visualConfidence, 0, 1, 0);
  let preset = CAMERA_PRESETS.has(raw.preset as CameraPreset) ? raw.preset as CameraPreset : "hold";
  const focus = FOCUS_TARGETS.has(raw.focus as FocusTarget) ? raw.focus as FocusTarget : "center";

  if (visualConfidence < 0.5 || (config?.allowPunchIns === false && preset === "punch_in")) {
    preset = "hold";
  }
  if (config?.motionIntensity === "subtle" && preset === "punch_in") {
    preset = "slow_push";
  }

  return {
    startMs,
    endMs,
    preset,
    focus,
    focusX: clampNumber(raw.focusX, 0, 1, 0.5),
    focusY: clampNumber(raw.focusY, 0, 1, 0.5),
    zoomFrom: clampNumber(raw.zoomFrom, 1, 1.25, 1),
    zoomTo: preset === "hold" ? 1 : clampNumber(raw.zoomTo, 1, 1.25, 1.04),
    visualConfidence,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 240) : "Validated fallback beat.",
  };
}

export function fallbackEditDirectionPlan(input: {
  candidate: ClipCandidate;
  renderConfig: RenderConfig | null;
}): EditDirectionPlan {
  const clipDurationMs = Math.max(1, input.candidate.compactEndMs ?? input.candidate.suggestedEndMs - input.candidate.suggestedStartMs);
  return {
    version: 1,
    summary: "Fallback steady edit direction.",
    camera: [{
      startMs: 0,
      endMs: clipDurationMs,
      preset: "hold",
      focus: "center",
      focusX: 0.5,
      focusY: 0.5,
      zoomFrom: 1,
      zoomTo: 1,
      visualConfidence: 1,
      reason: "Fallback plan keeps framing stable.",
    }],
    color: { preset: "neutral", intensity: input.renderConfig?.enableColor ? 0.25 : 0 },
    captions: { enabled: input.renderConfig?.enableCaptions !== false },
    pacing: { style: "steady" },
    music: { enabled: input.renderConfig?.enableMusic === true, mood: input.renderConfig?.enableMusic ? "subtle" : "none" },
  };
}

export function validateEditDirectionPlan(input: {
  rawPlan: unknown;
  candidate: ClipCandidate;
  renderConfig: RenderConfig | null;
}) {
  const fallback = fallbackEditDirectionPlan(input);
  if (input.renderConfig?.mode === "raw") {
    return fallback;
  }

  const raw = input.rawPlan && typeof input.rawPlan === "object" ? input.rawPlan as Record<string, unknown> : {};
  const clipDurationMs = Math.max(1, input.candidate.compactEndMs ?? input.candidate.suggestedEndMs - input.candidate.suggestedStartMs);
  const maxMotionEvents = motionEventCap(input.renderConfig);
  const beats = Array.isArray(raw.camera)
    ? raw.camera
        .map((beat) => normalizeBeat(beat, clipDurationMs, input.renderConfig))
        .filter((beat): beat is CameraBeat => Boolean(beat))
        .slice(0, maxMotionEvents)
    : [];

  return {
    ...fallback,
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 500) : fallback.summary,
    camera: maxMotionEvents > 0 && beats.length > 0 ? beats : fallback.camera,
    captions: { enabled: input.renderConfig?.enableCaptions !== false },
    music: { enabled: input.renderConfig?.enableMusic === true, mood: input.renderConfig?.enableMusic ? "subtle" : "none" },
  } satisfies EditDirectionPlan;
}

export function editDirectionMetadata() {
  return {
    promptVersion: EDIT_DIRECTION_PROMPT_VERSION,
    schemaVersion: EDIT_DIRECTION_SCHEMA_VERSION,
  };
}

function buildTranscriptContext(tokens: TranscriptToken[]) {
  return tokens
    .filter((token) => token.tokenKind === "word")
    .slice(0, 800)
    .map((token) => `[${token.startMs}-${token.endMs}] ${token.text}`)
    .join(" ");
}

export async function createEditDirectionPlan(input: {
  candidate: ClipCandidate;
  renderConfig: RenderConfig | null;
  transcriptTokens: TranscriptToken[];
  frameImageDataUrls?: string[];
  existingCallCount?: number;
}) {
  if (input.renderConfig?.mode === "raw") {
    return fallbackEditDirectionPlan(input);
  }
  if (
    !ENABLE_GPT_DIRECTION ||
    !process.env.OPENAI_API_KEY ||
    (input.existingCallCount ?? 0) >= MAX_GPT_DIRECTION_CALLS_PER_CANDIDATE
  ) {
    return fallbackEditDirectionPlan(input);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const directionPayload = {
      promptVersion: EDIT_DIRECTION_PROMPT_VERSION,
      schemaVersion: EDIT_DIRECTION_SCHEMA_VERSION,
      candidate: {
        title: input.candidate.title,
        hook: input.candidate.hook,
        reason: input.candidate.reason,
        durationMs: Math.max(
          1,
          input.candidate.compactEndMs ??
            input.candidate.suggestedEndMs - input.candidate.suggestedStartMs,
        ),
      },
      template: {
        motionIntensity: input.renderConfig?.motionIntensity ?? "subtle",
        allowPunchIns: input.renderConfig?.allowPunchIns ?? true,
        maxMotionEvents: input.renderConfig?.maxMotionEvents ?? 4,
        enableCaptions: input.renderConfig?.enableCaptions !== false,
        enableMusic: input.renderConfig?.enableMusic === true,
      },
      transcript: buildTranscriptContext(input.transcriptTokens),
      visualEvidenceFrameCount: input.frameImageDataUrls?.length ?? 0,
      requiredShape: {
        version: 1,
        summary: "string",
        camera: [
          {
            startMs: 0,
            endMs: 1000,
            preset: "hold|slow_push|slow_pull|subtle_pan|punch_in",
            focus: "center|detected_face|detected_largest_face|manual_coordinates|slide_or_board|full_frame",
            focusX: 0.5,
            focusY: 0.5,
            zoomFrom: 1,
            zoomTo: 1,
            visualConfidence: 0.0,
            reason: "string",
          },
        ],
        color: { preset: "neutral", intensity: 0 },
        captions: { enabled: true },
        pacing: { style: "steady|tight" },
        music: { enabled: false, mood: "none|subtle" },
      },
    };
    const userContent: any[] = [{ type: "text", text: JSON.stringify(directionPayload) }];
    for (const frame of input.frameImageDataUrls ?? []) {
      userContent.push({ type: "image_url", image_url: { url: frame, detail: "low" } });
    }

    const response = await client.chat.completions.create({
      model: EDIT_DIRECTOR_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an edit director. Return only strict JSON for an EditDirectionPlan. Never return code, shell commands, ffmpeg filters, React, CSS, or executable instructions. Use only known camera presets and focus targets. Prefer stable holds when visual confidence is low.",
        },
        {
          role: "user",
          content: userContent,
        },
      ],
    });
    return validateEditDirectionPlan({
      rawPlan: JSON.parse(response.choices[0]?.message?.content ?? "{}"),
      candidate: input.candidate,
      renderConfig: input.renderConfig,
    });
  } catch {
    return fallbackEditDirectionPlan(input);
  }
}
