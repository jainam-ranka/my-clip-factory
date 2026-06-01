# docs/gpt-directed-video-editing-plan.md

# GPT-Directed Video Editing Development Plan (Latest Scope)

## Repository Document Target

Suggested repository location:

```text
docs/gpt-directed-video-editing-plan.md
```

This document reflects the latest approved architecture scope for:

- AI-directed editing
- deterministic Remotion rendering
- raw clip extraction
- GPT validation boundaries
- music generation
- render orchestration
- rough-cut generation
- future scene analysis
- operational safeguards

---

## Current Scope Summary

The platform now supports two fully distinct rendering paths:

### 1. AI-Directed Edited Clips

Pipeline:

```text
Transcript shortlist
-> compaction
-> rough candidate generation
-> GPT visual review
-> validated edit direction plan
-> optional AI music generation
-> deterministic Remotion render
```

Capabilities:

- transcript-aware clip selection
- conservative filler compaction
- GPT-directed camera motion
- validated cinematic motion presets
- deterministic Remotion rendering
- optional AI-generated instrumental music
- subtitle rendering
- color grading
- pacing controls
- future scene analysis support

### 2. Raw Clip Extraction

Pipeline:

```text
Transcript shortlist
-> exact source extraction
-> final asset
```

Capabilities:

- no subtitles
- no AI edits
- no reframing
- no color grading
- no motion
- no overlays
- no music
- preserve original media properties
- near-instant ffmpeg stream-copy exports when possible

---

## Architectural Philosophy

The system is intentionally designed around:

```text
AI decides editorial intent
Software executes deterministic rendering
```

GPT never directly edits media.
GPT only produces constrained structured direction plans.

Validation, rendering, clamping, fallback behavior, and execution safety remain application-controlled.

---

# GPT-Directed Video Editing Development Plan (Latest Scope)

## Core Architectural Principle

The system should not be:

```text
GPT edits video magically
```

The system should be:

```text
GPT reviews visual evidence
GPT outputs validated direction JSON
Remotion executes known effects
ffmpeg prepares exact media
music provider generates optional score
```

The AI owns editorial intent.
The application owns deterministic execution.

---

# Added Architectural Decisions

## New: Raw Clip Mode

Purpose:

Allow users to export the exact candidate source range without any AI editing, subtitles, motion, music, branding, reframing, or post-processing.

Behavior:

- bypass GPT direction
- bypass Remotion
- bypass music generation
- bypass caption rendering
- bypass filler compaction
- preserve original aspect ratio
- preserve original FPS
- preserve original audio
- preserve original bitrate where possible
- preserve original dimensions

Pipeline:

```text
Candidate shortlist
-> raw clip extraction
-> final asset
```

Implementation:

- `src/lib/server/raw-render.ts`
- prefer ffmpeg stream copy (`-c copy`) where possible
- fallback to re-encode only if required

Template defaults:

```ts
{
  mode: "raw",
  enableCaptions: false,
  enableMotion: false,
  enableColor: false,
  enableMusic: false,
  enableCompaction: false
}
```

Exit criteria:

- exported clip visually matches original source segment
- export is significantly faster than Remotion render
- no overlays or modifications appear
- original audio/video properties are preserved

---

# New Risk Mitigations And Improvements

## Freeze Timing Before Direction Generation

Direction plans must be generated only after all transcript compaction and timing mutations are complete.

Correct order:

```text
candidate
-> compaction
-> rough cut
-> direction plan
-> render
```

Incorrect order:

```text
candidate
-> rough cut
-> direction
-> later trimming
```

Reason:

Direction timestamps become invalid if clip timing changes after GPT planning.

---

## Add Visual Confidence

Add confidence scoring to camera beats.

Updated type:

```ts
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
```

Purpose:

- reduce motion when confidence is low
- avoid punch-ins on uncertain framing
- prefer holds during ambiguous scenes
- improve visual stability

Suggested clamp:

```text
0.0 -> 1.0
```

Behavior:

- low confidence defaults toward `hold`
- low confidence suppresses aggressive motion

---

## Replace Semantic Speaker Positioning

Avoid:

```ts
focus: "left_speaker" | "right_speaker"
```

Reason:

Sparse frames are insufficient for reliable speaker tracking.

Replace with:

```ts
export type FocusTarget =
  | "center"
  | "detected_face"
  | "detected_largest_face"
  | "manual_coordinates"
  | "slide_or_board"
  | "full_frame";
```

Future enhancement:

- lightweight face detection
- MediaPipe/OpenCV guidance
- normalized bounding boxes
- GPT selects among detected regions

This prevents hallucinated speaker positioning.

---

## Add Cost Controls

Add config:

```ts
export const MAX_GPT_DIRECTION_CALLS_PER_CANDIDATE = Number(process.env.MAX_GPT_DIRECTION_CALLS_PER_CANDIDATE ?? 3);
export const MAX_TOTAL_DIRECTION_FRAMES = Number(process.env.MAX_TOTAL_DIRECTION_FRAMES ?? 24);
export const MAX_ROUGH_DURATION_MS = Number(process.env.MAX_ROUGH_DURATION_MS ?? 120000);
```

Purpose:

- prevent runaway GPT costs
- avoid excessive visual uploads
- bound regeneration loops
- protect infrastructure spend

---

## Add Reproducibility Metadata

Persist:

- prompt version
- renderer version
- direction schema version
- template version
- render signature hash

Reason:

Future debugging and deterministic reproduction require version tracking.

Recommended DB additions:

```sql
ALTER TABLE edit_direction_plans
ADD COLUMN prompt_version TEXT;

ALTER TABLE edit_direction_plans
ADD COLUMN schema_version TEXT;

ALTER TABLE renders
ADD COLUMN renderer_version TEXT;

ALTER TABLE renders
ADD COLUMN render_signature TEXT;
```

---

## Add Idempotent Stage Execution

Every pipeline stage should be resumable.

Requirements:

- reuse existing rough cuts
- reuse direction plans when unchanged
- reuse generated music when valid
- avoid duplicate ffmpeg work
- avoid duplicate GPT calls

Purpose:

- operational efficiency
- retry safety
- queue resilience
- render reproducibility

---

## Add Lightweight Motion Preview Support

Static frames do not capture pacing or gestures.

Add optional support for:

- low-resolution preview video
- short GIF previews
- 3-5 second motion snippets

Reason:

This improves GPT editorial judgment.

Especially important for:

- gestures
- pauses
- emotional pacing
- movement velocity
- eye contact

---

## Future Semantic Anchors

Current:

```ts
startMs
endMs
```

Future improvement:

```ts
anchorTranscriptTokenId
anchorOffsetMs
```

or:

```ts
anchorWord
```

Purpose:

Allow camera intent to survive:

- transcript compaction
- timing shifts
- intro insertion
- scene insertion
- future editing mutations

Not required in v1.

---

## Future Scene Analysis Module

Planned future module:

```text
src/lib/server/scene-analysis.ts
```

Responsibilities:

- shot boundary detection
- scene segmentation
- slide detection
- face change detection
- visual pacing cues

This can later improve:

- punch timing
- beat placement
- hold decisions
- camera reset timing

---

# Updated Goal

Add a second-pass editing workflow where GPT reviews the rough candidate video and returns a strict, validated edit direction plan. The app then uses Remotion and ffmpeg to execute that plan deterministically.

The core idea:

```text
Transcript shortlist -> rough candidate video -> GPT visual direction -> validated edit plan -> Remotion render
```

Additionally support:

```text
Transcript shortlist -> raw clip extraction -> final asset
```

GPT should not edit video directly.
GPT should direct the edit through a controlled JSON schema.
The app owns validation, limits, rendering, and fallbacks.

---

# Updated Non-Goals

- Do not let GPT produce arbitrary React, CSS, ffmpeg commands, or Remotion code.
- Do not let GPT directly modify source video files.
- Do not replace Remotion.
- Do not depend on Sora/video editing APIs for the core workflow.
- Do not require heavy computer vision in v1.
- Do not apply random motion constantly.
- Motion should support meaning.
- Do not over-edit clips.
- Do not allow AI to bypass validation.

---

# Updated Pipeline

## Edited Pipeline

```text
Audio-first ingestion
Transcript generation
Candidate shortlisting
Conservative filler compaction
Rough video creation
GPT visual direction
Music generation
Final render
```

## Raw Pipeline

```text
Audio-first ingestion
Transcript generation
Candidate shortlisting
Raw clip extraction
Final asset
```

---

# Updated Template Model

```ts
export type TemplateMode =
  | "edited"
  | "raw";

export type TemplateConfig = {
  mode: TemplateMode;

  aiMotionEnabled: boolean;
  motionIntensity: "none" | "subtle" | "moderate";
  allowPunchIns: boolean;
  maxMotionEvents: number;

  enableCaptions: boolean;
  enableMotion: boolean;
  enableColor: boolean;
  enableMusic: boolean;
  enableCompaction: boolean;

  colorGradePreset: ColorPreset;
  aiMusicEnabled: boolean;
};
```

Raw defaults:

```ts
{
  mode: "raw",
  aiMotionEnabled: false,
  motionIntensity: "none",
  allowPunchIns: false,
  maxMotionEvents: 0,
  enableCaptions: false,
  enableMotion: false,
  enableColor: false,
  enableMusic: false,
  enableCompaction: false,
  colorGradePreset: "neutral",
  aiMusicEnabled: false
}
```

Edited defaults:

```ts
{
  mode: "edited",
  aiMotionEnabled: true,
  motionIntensity: "subtle",
  allowPunchIns: true,
  maxMotionEvents: 4,
  enableCaptions: true,
  enableMotion: true,
  enableColor: true,
  enableMusic: false,
  enableCompaction: true,
  colorGradePreset: "neutral",
  aiMusicEnabled: false
}
```

---

# Updated Validation Rules

Additional validation:

- raw mode must not generate direction plans
- raw mode must not generate music
- raw mode bypasses Remotion
- visual confidence must be clamped
- motion intensity must obey template caps
- total motion events must obey template limits
- renderer version must be persisted

Additional clamps:

```text
visualConfidence: 0.0 -> 1.0
```

Behavior:

- low-confidence punch-ins are downgraded to holds
- excessive motion is collapsed into subtle motion

---

# New Raw Render Module

## File

```text
src/lib/server/raw-render.ts
```

## Responsibilities

- direct clip extraction
- preserve source media properties
- use ffmpeg stream-copy where possible
- bypass Remotion rendering

## Functions

```ts
extractRawClip(input)
validateRawClipRange(input)
```

Preferred ffmpeg strategy:

```bash
ffmpeg -ss START -to END -i source.mp4 -c copy output.mp4
```

Fallback:

```bash
ffmpeg -ss START -to END -i source.mp4 -c:v libx264 output.mp4
```

---

# Updated Direction Plan Schema

```ts
export type EditDirectionPlan = {
  version: 1;
  summary: string;
  camera: CameraBeat[];
  color: ColorDirection;
  captions: CaptionDirection;
  pacing: PacingDirection;
  music: MusicDirection;
};

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
```

---

# Updated Rendering Rules

## Edited Renders

Edited renders:

- use Remotion
- use camera motion
- use color grading
- use captions
- optionally use generated music
- obey direction plan

## Raw Renders

Raw renders:

- bypass Remotion
- bypass GPT direction
- bypass music generation
- bypass captions
- preserve source aspect ratio
- preserve source FPS
- preserve source audio mix

---

# Updated Approval Flow

## Edited Flow

```text
Candidate approved
-> compaction
-> rough cut
-> GPT direction
-> music generation
-> Remotion render
```

## Raw Flow

```text
Candidate approved
-> raw clip extraction
-> final asset
```

---

# Updated API Changes

## Existing

### `POST /api/candidates/[id]/approve`

Behavior:

If edited template:

```text
set template config
-> prepare rough cut
-> create direction plan
-> generate music if enabled
-> queue Remotion render
```

If raw template:

```text
set template config
-> extract raw clip
-> finalize asset
```

---

# Updated Config

```ts
export const ENABLE_GPT_DIRECTION = process.env.ENABLE_GPT_DIRECTION !== "false";
export const ENABLE_AI_MUSIC = process.env.ENABLE_AI_MUSIC === "true";
export const EDIT_DIRECTOR_MODEL = process.env.EDIT_DIRECTOR_MODEL ?? DEFAULT_OPENAI_MODEL;
export const MAX_DIRECTION_FRAMES = Number(process.env.MAX_DIRECTION_FRAMES ?? 24);
export const ROUGH_CUT_BUFFER_MS = Number(process.env.ROUGH_CUT_BUFFER_MS ?? 1500);
export const MUSIC_PROVIDER = process.env.MUSIC_PROVIDER ?? "none";
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";

export const MAX_GPT_DIRECTION_CALLS_PER_CANDIDATE = Number(process.env.MAX_GPT_DIRECTION_CALLS_PER_CANDIDATE ?? 3);
export const MAX_TOTAL_DIRECTION_FRAMES = Number(process.env.MAX_TOTAL_DIRECTION_FRAMES ?? 24);
export const MAX_ROUGH_DURATION_MS = Number(process.env.MAX_ROUGH_DURATION_MS ?? 120000);
```

---

# Updated Safety Rules

- GPT never returns executable code.
- GPT never returns shell commands.
- GPT never returns arbitrary ffmpeg filters.
- Unknown presets are ignored.
- Render always has a fallback plan.
- Motion is limited by template settings.
- Music generation is disabled unless configured.
- Commercial licensing status must be stored.
- Raw mode bypasses AI editing entirely.
- AI never directly mutates source media.
- Timing must freeze before direction generation.
- Validation always overrides GPT output.

---

# Updated Recommended First Batch

Implement first:

- `EditDirectionPlan` types
- validation layer
- fallback plan
- `DirectedCamera`
- mock direction plans
- render signature hashing

Then implement:

- rough cut creation
- frame extraction
- contact sheets
- GPT director

Then implement:

- raw clip extraction
- idempotent orchestration
- visual confidence scoring

Then implement:

- music provider
- scene analysis
- face detection guidance
- semantic anchors
- UI review surface

---

# Production Readiness Notes

## Operational Goals

The architecture should support:

- deterministic rendering
- resumable pipelines
- idempotent processing
- cost governance
- reproducible outputs
- safe AI integration
- render signature hashing
- future multi-template expansion
- future scene understanding
- future multi-speaker guidance

---

## Recommended Future Enhancements

### Near-Term

- lightweight face detection
- render diff previews
- AI direction regeneration
- user motion controls
- validation warning UI
- render-side analytics

### Mid-Term

- semantic timeline anchors
- scene segmentation
- slide-aware framing
- emotion-aware pacing
- adaptive punch-in suppression
- motion fatigue scoring

### Long-Term

- multi-camera awareness
- automatic reframing
- layout-aware editing
- multi-track audio direction
- AI-assisted shot sequencing
- reusable editing styles

---

# Final Architecture Statement

The system should not be:

```text
GPT edits videos directly
```

The system should be:

```text
GPT reviews visual evidence
GPT outputs validated direction JSON
Validation constrains the plan
Remotion executes deterministic effects
ffmpeg prepares exact media
raw mode bypasses AI entirely
music provider generates optional score
```

That boundary is what makes the system:

- reliable
- reproducible
- scalable
- debuggable
- commercially viable
- operationally safe
- visually controllable
- cost-governable

