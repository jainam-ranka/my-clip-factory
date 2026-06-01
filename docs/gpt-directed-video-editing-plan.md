# GPT-Directed Video Editing Development Plan

## Goal

Add a second-pass editing workflow where GPT reviews the rough candidate video and returns a strict, validated edit direction plan. The app then uses Remotion and ffmpeg to execute that plan deterministically.

The core idea:

```text
Transcript shortlist -> rough candidate video -> GPT visual direction -> validated edit plan -> Remotion render
```

GPT should not edit video directly. GPT should direct the edit through a controlled JSON schema. The app owns validation, limits, rendering, and fallbacks.

## Why This Architecture

Transcript-only clipping can identify what is interesting, but it cannot see:

- speaker location
- framing quality
- lighting
- slide or whiteboard visibility
- whether a punch-in would help
- whether a scene needs a warmer/cooler grade
- whether a visual pause should be held
- whether the shot is too static

The second pass gives GPT visual context without letting it mutate the renderer. It can decide editorial intent, but Remotion only executes known operations.

## Non-Goals

- Do not let GPT produce arbitrary React, CSS, ffmpeg commands, or Remotion code.
- Do not let GPT directly modify source video files.
- Do not replace Remotion.
- Do not depend on Sora/video editing APIs for the core workflow.
- Do not require heavy computer vision in v1.
- Do not apply random motion constantly. Motion should support meaning.

## Current Pipeline Position

This plan should sit after the reliability/audio-first work:

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

The rough video creation step is required because the first candidate is based primarily on transcript and audio. GPT needs visual evidence before directing camera motion, color, pacing, and music mood.

## Current Implementation Compatibility Notes

The current app already has partial support for the reliability foundation this plan depends on:

- `runs` stores source mode, source duration, source media strategy, analysis audio path, and capture error codes.
- `segments` supports audio/video media types and retention state.
- `transcript_tokens` supports filler/removal metadata and user edits.
- `clip_spans` stores compacted source-to-output timeline spans.
- `approved_media_ranges` stores downloaded VOD ranges or copied live cache ranges.
- `render_templates` stores font, subtitle mode, music, intro/outro, placement, layout, and fill behavior.
- `render_jobs` stores render signatures and clip span snapshots.

The GPT-directed workflow must extend these existing concepts instead of creating a parallel render path.

Important compatibility constraints:

- Do not calculate final render duration from the original candidate bounds after compaction. Final render duration must come from the compacted output timeline.
- Direction beats must target the final compacted output timeline, not the original source timeline.
- Render signatures must include direction plan identity/hash and generated music identity/hash.
- Approval should not perform long-running direction/music work inside the HTTP request. It should enqueue resumable background stages.
- Template font selection currently needs a real Remotion font-loading path for arbitrary Google Fonts.

## Timeline Contract

Timing must be frozen before GPT direction runs.

Required order:

```text
candidate
-> conservative compaction
-> approved source media range
-> compacted rough cut
-> visual evidence
-> GPT direction plan
-> generated/template music
-> final render
```

Do not run compaction after GPT direction generation.

All `EditDirectionPlan` beat timestamps are in final compacted output time:

```text
0ms = first frame of main compacted clip
clipDurationMs = last frame of main compacted clip before outro
```

Source timestamps remain available only for:

- fetching VOD ranges.
- copying live cache ranges.
- tracing transcript tokens back to original media.
- creating rough cuts and visual evidence.

This avoids camera beats, music cues, captions, and filler cuts drifting apart.

## High-Level Workflow

## Stage 1: Rough Candidate From Transcript

Input:

- transcript tokens
- source metadata
- rolling transcript window or VOD transcript segment

Output:

- `candidate`
- rough start/end
- title
- hook
- reason
- confidence

This remains the cheap stage. It should not download or render the final video.

## Stage 2: Build Rough Video For Direction

After a candidate is shortlisted or before final approval, create a temporary rough video.

For VOD:

- Download only the rough candidate video range.
- Include a small buffer before/after the candidate.
- Store it temporarily.

For live:

- Use temporary live cache if the range is still retained.
- If unavailable, surface clear expiration state.

Storage:

```text
storage/<run-id>/rough-cuts/<candidate-id>/
  rough.mp4
  rough-preview.mp4
  spritesheet.jpg
  frames/
    frame-000.jpg
    frame-001.jpg
  audio-profile.json
  transcript-window.json
```

Recommended rough buffer:

- `1500ms` before candidate start
- `1500ms` after candidate end

Reason:

- GPT can see the incoming/outgoing context.
- Filler compaction and camera beats have room to breathe.

## Stage 3: Extract Visual Evidence

Do not send a huge video blindly to GPT in v1. Send a compact visual package.

Generate:

- contact sheet / spritesheet
- key frames every `1-2s`
- optional first/middle/last frames
- low-resolution rough preview video or GIF where model/provider support allows it
- rough clip duration
- aspect ratio
- transcript aligned to rough clip
- candidate reason
- template settings
- optional visual targets such as face/board boxes

Frame extraction file:

- New: `src/lib/server/video-sampling.ts`

Functions:

- `extractDirectionFrames(input)`
- `buildContactSheet(input)`
- `probeVisualMetadata(input)`

Use ffmpeg for:

- frame extraction
- contact sheet generation
- low-res preview generation

Static contact sheets capture composition but not pacing. The low-res preview should be retained so the system can later send motion evidence to models that support it, or expose it in the UI for human review.

## Stage 4: GPT Edit Direction

GPT receives:

- transcript
- candidate title/hook/reason
- compacted spans if available
- visual frames/contact sheet
- source aspect ratio
- selected template
- allowed motion presets
- allowed color presets
- allowed caption behavior
- music API constraints

GPT returns:

- strict JSON
- no prose
- no arbitrary commands
- no invented preset names

New file:

- `src/lib/server/edit-director.ts`

Responsibilities:

- build prompt
- call OpenAI
- parse JSON
- validate plan
- store plan
- return fallback plan if needed

## Direction Plan Schema

TypeScript shape:

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
  focusMode: FocusMode;
  focusTargetId: string | null;
  focusX: number;
  focusY: number;
  zoomFrom: number;
  zoomTo: number;
  visualConfidence: number;
  reason: string;
};

export type CameraPreset =
  | "hold"
  | "slow_zoom_in"
  | "slow_zoom_out"
  | "punch_in"
  | "gentle_pan_left"
  | "gentle_pan_right"
  | "reset_wide";

export type FocusMode =
  | "center"
  | "detected_face"
  | "detected_largest_face"
  | "manual_coordinates"
  | "slide_or_board"
  | "full_frame";

export type VisualTarget = {
  id: string;
  kind: "face" | "slide_or_board" | "full_frame";
  startMs: number;
  endMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

export type ColorDirection = {
  preset: ColorPreset;
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: "cool" | "neutral" | "warm";
  reason: string;
};

export type ColorPreset =
  | "neutral"
  | "warm_contrast"
  | "cool_clean"
  | "whiteboard_clarity"
  | "low_light_lift";

export type CaptionDirection = {
  mode: "one_word";
  emphasisWords: string[];
};

export type PacingDirection = {
  targetEnergy: "calm" | "balanced" | "high";
  maxPunchIns: number;
  holdImportantVisuals: boolean;
};

export type MusicDirection = {
  enabled: boolean;
  mood: string;
  energy: "low" | "medium" | "high";
  tempo: "slow" | "medium" | "fast";
  avoid: string[];
};
```

Do not ask GPT to infer persistent `left_speaker` or `right_speaker` identities from sparse frames in v1. Speaker positions can change, camera layouts can change, and sparse samples can make GPT hallucinate continuity.

Instead:

- detect visual targets locally where practical.
- provide normalized target boxes/centers to GPT.
- let GPT select a detected target or fall back to center/manual coordinates.
- downgrade uncertain target choices to `hold` or `center`.

Face/board detection can be optional in v1. If no visual targets exist, the validator must still produce a safe plan.

## Validation Layer

New file:

- `src/lib/server/edit-plan-validation.ts`

Validation rules:

- `version` must be supported.
- beat times must be inside final clip duration.
- beats must not overlap.
- gaps are allowed but default to `hold`.
- unknown camera preset becomes `hold`.
- `zoomFrom` and `zoomTo` are clamped.
- `focusX` and `focusY` are clamped.
- `visualConfidence` is clamped.
- low visual confidence downgrades `punch_in` to `hold` or `slow_zoom_in`.
- color values are clamped.
- max punch-ins are enforced.
- excessive motion falls back to subtle motion.
- caption mode must remain `one_word`.
- music directions must avoid vocals by default.

Recommended clamps:

- `zoom`: `1.0` to `1.16`
- punch-in max zoom: `1.18`
- `focusX`: `0.15` to `0.85`
- `focusY`: `0.15` to `0.85`
- `visualConfidence`: `0` to `1`
- minimum visual confidence for punch-in: `0.75`
- `brightness`: `0.9` to `1.12`
- `contrast`: `0.9` to `1.18`
- `saturation`: `0.85` to `1.18`
- max camera beats: `8`
- max punch-ins: `2`

Fallback plan:

```json
{
  "version": 1,
  "summary": "Fallback subtle motion plan.",
  "camera": [
    {
      "startMs": 0,
      "endMs": "clipDuration",
      "preset": "slow_zoom_in",
      "focusMode": "center",
      "focusTargetId": null,
      "focusX": 0.5,
      "focusY": 0.5,
      "zoomFrom": 1,
      "zoomTo": 1.04,
      "visualConfidence": 1,
      "reason": "Safe default"
    }
  ],
  "color": {
    "preset": "neutral",
    "brightness": 1,
    "contrast": 1,
    "saturation": 1,
    "temperature": "neutral",
    "reason": "Safe default"
  },
  "captions": {
    "mode": "one_word",
    "emphasisWords": []
  },
  "pacing": {
    "targetEnergy": "balanced",
    "maxPunchIns": 0,
    "holdImportantVisuals": true
  },
  "music": {
    "enabled": false,
    "mood": "",
    "energy": "low",
    "tempo": "medium",
    "avoid": ["vocals"]
  }
}
```

## Prompt Contract

GPT system role:

```text
You are a video editor directing a short social clip.
Return only strict JSON matching the provided schema.
You may choose only from the listed presets.
Do not invent effects, styles, commands, or file names.
Use motion sparingly.
Preserve readability and speaker clarity.
Do not suggest cuts that remove spoken words halfway.
```

GPT user payload:

```json
{
  "clipDurationMs": 52000,
  "aspectRatio": "16:9",
  "template": {
    "layout": "landscape",
    "captionMode": "one_word",
    "captionPlacement": "bottom",
    "fontFamily": "Archivo"
  },
  "transcript": [
    {
      "text": "Jupiter",
      "startMs": 1200,
      "endMs": 1560
    }
  ],
  "candidate": {
    "title": "...",
    "hook": "...",
    "reason": "..."
  },
  "visualEvidence": {
    "frames": [
      {
        "timestampMs": 0,
        "description": "frame-000.jpg"
      }
    ]
  },
  "allowedPresets": {
    "camera": ["hold", "slow_zoom_in", "slow_zoom_out", "punch_in", "gentle_pan_left", "gentle_pan_right", "reset_wide"],
    "color": ["neutral", "warm_contrast", "cool_clean", "whiteboard_clarity", "low_light_lift"]
  }
}
```

## Database Changes

Implement in:

- `src/lib/server/db.ts`

## New Table: `rough_cuts`

```sql
CREATE TABLE IF NOT EXISTS rough_cuts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  video_path TEXT NOT NULL,
  preview_path TEXT,
  spritesheet_path TEXT,
  frame_dir TEXT,
  duration_ms INTEGER NOT NULL,
  buffer_start_ms INTEGER NOT NULL,
  buffer_end_ms INTEGER NOT NULL,
  expires_at TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_rough_cuts_candidate ON rough_cuts(candidate_id);
CREATE INDEX IF NOT EXISTS idx_rough_cuts_run ON rough_cuts(run_id);
```

## New Table: `edit_direction_plans`

```sql
CREATE TABLE IF NOT EXISTS edit_direction_plans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  rough_cut_id TEXT,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  direction_schema_version INTEGER NOT NULL,
  renderer_version TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  input_summary_json TEXT,
  validation_warnings_json TEXT,
  visual_confidence REAL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_edit_direction_candidate ON edit_direction_plans(candidate_id);
CREATE INDEX IF NOT EXISTS idx_edit_direction_run ON edit_direction_plans(run_id);
```

## New Table: `generated_music_tracks`

```sql
CREATE TABLE IF NOT EXISTS generated_music_tracks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  edit_direction_plan_id TEXT,
  provider TEXT NOT NULL,
  provider_model TEXT,
  prompt TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  audio_path TEXT NOT NULL,
  normalized_audio_path TEXT,
  loudness_lufs REAL,
  ducking_applied INTEGER NOT NULL DEFAULT 0,
  license_status TEXT,
  license_metadata_json TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_generated_music_candidate ON generated_music_tracks(candidate_id);
CREATE INDEX IF NOT EXISTS idx_generated_music_run ON generated_music_tracks(run_id);
```

## Type Changes

Update:

- `src/lib/types.ts`

Add:

- `EditDirectionPlan`
- `CameraBeat`
- `CameraPreset`
- `ColorDirection`
- `ColorPreset`
- `CaptionDirection`
- `MusicDirection`
- `RoughCut`
- `GeneratedMusicTrack`

Update `ClipRenderProps`:

```ts
directionPlan: EditDirectionPlan | null;
generatedMusicSrc: string | null;
```

## Repository Changes

Update:

- `src/lib/server/repository.ts`

Add functions:

- `createRoughCut(input)`
- `getRoughCut(candidateId)`
- `markRoughCut(input)`
- `createEditDirectionPlan(input)`
- `getLatestEditDirectionPlan(candidateId)`
- `markEditDirectionPlan(input)`
- `createGeneratedMusicTrack(input)`
- `getGeneratedMusicTrack(candidateId)`
- `markGeneratedMusicTrack(input)`

All new repository writes must be idempotent:

- reuse a valid rough cut if it already exists.
- reuse a valid direction plan for the same rough cut/template/schema/prompt version.
- reuse a generated music track for the same direction plan/provider/prompt.
- never duplicate expensive ffmpeg, GPT, or music-provider work if a valid artifact exists.

## Rough Cut Module

New file:

- `src/lib/server/rough-cut.ts`

Responsibilities:

- download or prepare rough video range
- generate preview video
- call frame sampling
- persist rough cut record

Functions:

- `prepareRoughCutForCandidate(candidateId)`
- `getRoughCutPaths(runId, candidateId)`
- `cleanupExpiredRoughCuts()`

## Video Sampling Module

New file:

- `src/lib/server/video-sampling.ts`

Responsibilities:

- extract frames
- build contact sheet
- probe duration/aspect ratio
- generate low-res preview

Functions:

- `extractFrames(input)`
- `buildSpritesheet(input)`
- `probeVideoForDirection(input)`

Recommended frame cadence:

- clips under `30s`: every `1s`
- clips `30-90s`: every `2s`
- max frames sent to GPT: `24`

## Edit Director Module

New file:

- `src/lib/server/edit-director.ts`

Responsibilities:

- build GPT prompt
- send frames/contact sheet + transcript
- parse structured result
- validate result
- persist plan

Functions:

- `createEditDirectionForCandidate(candidateId)`
- `buildDirectionPrompt(input)`
- `parseDirectionResponse(input)`

OpenAI input strategy:

- Use image/frame inputs and transcript text.
- Prefer sampled frames/contact sheet in v1.
- Do not rely on uploaded video editing as the core path.

Reason:

- Official OpenAI vision/image input is suitable for visual review.
- Uploaded-video editing workflows may require eligibility and are not necessary for deterministic Remotion rendering.

## Music Generation Module

New file:

- `src/lib/server/music-generation.ts`

Responsibilities:

- convert GPT music direction into provider prompt
- call music provider
- download generated track
- normalize/trim/fade music
- persist track

Provider recommendation:

- Start with ElevenLabs Music API if available.

Why:

- It is positioned for commercial use.
- It supports text-prompt music generation.
- It supports duration controls.
- It has TypeScript/Python SDK positioning.

Alternative:

- MusicAPI.ai as a secondary adapter after licensing review.

Interface:

```ts
export type MusicProvider = {
  generate(input: MusicGenerationInput): Promise<GeneratedMusicResult>;
};
```

Add provider config:

- `MUSIC_PROVIDER`
- `ELEVENLABS_API_KEY`
- `MUSICAPI_API_KEY`
- `ENABLE_AI_MUSIC`

## Rendering Changes

Update:

- `src/lib/server/rendering.ts`
- `src/remotion/LiveClipComposition.tsx`

Server-side rendering responsibilities:

- load latest validated direction plan
- load generated music if available
- pass direction plan into Remotion props
- include direction plan in render signature
- fallback to deterministic default if missing
- derive `clipFrames` and `durationInFrames` from compacted output duration, not original candidate source bounds
- include renderer version in cache signatures

Remotion responsibilities:

- apply camera motion to main video only
- keep captions fixed above moving video
- keep intro/outro independent from camera motion
- apply color grade to main video only
- use generated music if present

Render signature must hash:

- candidate title and hook.
- edited transcript text used for captions.
- source bounds and compacted clip spans.
- render template values and template updated version.
- intro/outro/music asset identifiers.
- generated music track identifier/hash.
- edit direction plan identifier/hash.
- direction schema version.
- renderer version.

Without this, stale renders can be reused after transcript edits, compaction changes, template edits, or new GPT direction.

## Remotion Camera Layer

New component:

- `src/remotion/blocks/DirectedCamera.tsx`

Inputs:

- `directionPlan`
- `clipFrames`
- `format`
- `videoFillMode`

Behavior:

- find active camera beat by current frame
- interpolate zoom
- interpolate focus
- apply transform to video layer

Example implementation idea:

```tsx
const currentMs = (frame / fps) * 1000;
const beat = findActiveBeat(directionPlan.camera, currentMs);
const progress = getBeatProgress(beat, currentMs);
const zoom = interpolate(progress, [0, 1], [beat.zoomFrom, beat.zoomTo]);

return (
  <AbsoluteFill
    style={{
      transform: `scale(${zoom})`,
      transformOrigin: `${beat.focusX * 100}% ${beat.focusY * 100}%`,
    }}
  >
    {children}
  </AbsoluteFill>
);
```

## Color Grade Layer

New component:

- `src/remotion/blocks/ColorGrade.tsx`

Initial implementation:

- CSS filter for preview/render consistency.

Supported presets:

- `neutral`
- `warm_contrast`
- `cool_clean`
- `whiteboard_clarity`
- `low_light_lift`

Later:

- move heavier grading to ffmpeg LUT/filtergraph if CSS filters are not enough.

## Music Integration

Existing template music remains valid.

Priority:

1. generated music from edit direction
2. template music asset
3. no music

Rules:

- no vocals by default
- normalize generated music
- fade in/out
- duck under speech
- music only during main clip

## Approval Flow

Recommended v1 UX:

1. Candidate appears.
2. User opens transcript/rough cut if needed.
3. User approves with template.
4. App prepares rough cut.
5. GPT creates direction plan.
6. Music generation runs if enabled.
7. Render starts.

Approval must enqueue work rather than perform the whole chain synchronously inside the HTTP request.

Recommended candidate/render pipeline states:

```text
approved
-> preparing_media
-> compacting
-> preparing_rough_cut
-> directing
-> generating_music
-> queued_render
-> rendering
-> rendered
```

Every state must be resumable after server restart. If a stage fails, the UI should show the failed stage and a retry action that resumes from the last valid artifact.

Optional later UX:

- show direction plan preview before final render.
- allow user to regenerate direction.
- allow user to disable AI motion per render.

## API Changes

New APIs:

### `POST /api/candidates/[id]/prepare-rough-cut`

Creates rough video and visual evidence.

### `POST /api/candidates/[id]/direct-edit`

Runs GPT direction pass.

### `POST /api/candidates/[id]/generate-music`

Generates background score.

### `GET /api/candidates/[id]/edit-plan`

Returns latest direction plan and validation warnings.

Update existing:

### `POST /api/candidates/[id]/approve`

Should orchestrate:

1. set template render config
2. prepare rough cut
3. create edit direction plan
4. generate music if enabled
5. queue render

## Config Changes

Update:

- `src/lib/config.ts`

Add:

```ts
export const ENABLE_GPT_DIRECTION = process.env.ENABLE_GPT_DIRECTION !== "false";
export const ENABLE_AI_MUSIC = process.env.ENABLE_AI_MUSIC === "true";
export const EDIT_DIRECTOR_MODEL = process.env.EDIT_DIRECTOR_MODEL ?? DEFAULT_OPENAI_MODEL;
export const MAX_DIRECTION_FRAMES = Number(process.env.MAX_DIRECTION_FRAMES ?? 24);
export const ROUGH_CUT_BUFFER_MS = Number(process.env.ROUGH_CUT_BUFFER_MS ?? 1500);
export const MAX_GPT_DIRECTION_CALLS_PER_CANDIDATE = Number(process.env.MAX_GPT_DIRECTION_CALLS_PER_CANDIDATE ?? 2);
export const MAX_ROUGH_DURATION_MS = Number(process.env.MAX_ROUGH_DURATION_MS ?? 120_000);
export const MUSIC_PROVIDER = process.env.MUSIC_PROVIDER ?? "none";
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
```

Cost controls:

- hard cap rough-cut duration.
- hard cap frames sent to GPT.
- hard cap GPT direction calls per candidate.
- disable AI music by default.
- cache successful direction plans and generated tracks.

## Template Changes

Update template model later with:

- `aiMotionEnabled`
- `motionIntensity`
- `allowPunchIns`
- `maxMotionEvents`
- `colorGradePreset`
- `aiMusicEnabled`
- `defaultColorGradePreset`
- `fontLoadStrategy`

Defaults:

- `aiMotionEnabled = true`
- `motionIntensity = "subtle"`
- `allowPunchIns = true`
- `maxMotionEvents = 4`
- `colorGradePreset = "neutral"`
- `aiMusicEnabled = false`

Template compatibility notes:

- Template-selected fonts must be loaded in Remotion, not only stored in SQLite.
- Google Fonts should be resolved to a known import/load strategy before render.
- System fonts should be treated as best-effort and surfaced with a warning if unavailable.
- AI motion should be disableable per template.
- AI music should remain opt-in per template.

## Execution Milestones

## Milestone 1: Direction Plan Schema

Deliverables:

- TypeScript types.
- DB table.
- repository functions.
- validation module.
- fallback direction plan.
- render signature contract.
- compacted timeline duration helper.

Exit criteria:

- Invalid direction plans are rejected or corrected.
- Valid plans persist and load.
- Mock direction plans render against compacted timeline duration.

## Milestone 2: Deterministic Remotion Execution

Deliverables:

- directed camera layer.
- color grade layer.
- mock direction-plan fixture.
- render prop integration.
- render signature update.

Exit criteria:

- slow zoom, punch-in, hold, and pan presets render correctly from mock JSON.
- captions remain stable.
- intro/outro remain unaffected.
- rendered duration matches compacted spans.

## Milestone 3: Rough Cut And Visual Evidence

Deliverables:

- rough cut generation.
- frame extraction.
- contact sheet generation.
- visual metadata probe.
- optional low-res preview.
- optional visual target detection.

Exit criteria:

- Each candidate can produce a compacted rough video.
- Each rough video can produce frames/contact sheet.
- Existing rough cuts are reused idempotently.

## Milestone 4: GPT Director

Deliverables:

- prompt builder.
- OpenAI call.
- strict JSON parse.
- validation.
- plan persistence.
- visual confidence handling.

Exit criteria:

- GPT returns a valid edit plan for a rough candidate.
- Bad output falls back safely.
- Low-confidence visual plans are downgraded safely.

## Milestone 5: Music API

Deliverables:

- provider interface.
- ElevenLabs adapter.
- generated track persistence.
- license metadata persistence.
- audio normalization and ducking.

Exit criteria:

- generated instrumental track renders under speech.
- music is not louder than speaker.
- no generated music if feature disabled.
- license metadata is stored with the track.

## Milestone 6: UI Review Surface

Deliverables:

- show rough cut preview.
- show direction plan summary.
- show validation warnings.
- show music status.
- show stage-specific retry actions.

Exit criteria:

- user can understand why final render looks the way it does.
- errors are human-readable.

## Milestone 7: Scene And Face Guidance

Deliverables:

- lightweight shot/scene boundary detector.
- lightweight face/board target extraction.
- target summaries passed to GPT.

Exit criteria:

- GPT no longer guesses persistent speaker positions from sparse frames.
- punch-ins avoid cropping faces, boards, and slides.

## Test Plan

## Unit Tests

Add tests for:

- edit direction validation.
- beat overlap handling.
- zoom/focus clamping.
- visual confidence downgrade handling.
- fallback plan generation.
- color preset mapping.
- music prompt generation.
- render signature invalidation.
- compacted timeline duration calculation.

Potential files:

- `src/lib/server/edit-plan-validation.test.ts`
- `src/lib/server/edit-director.test.ts`
- `src/lib/server/music-generation.test.ts`
- `src/remotion/blocks/DirectedCamera.test.ts`

## Integration Tests

### Direction Plan Test

Steps:

1. Create candidate.
2. Prepare rough cut.
3. Extract frames.
4. Run GPT director.
5. Store plan.

Pass criteria:

- plan exists.
- plan validates.
- plan references only allowed presets.
- plan times are within compacted output duration.

### Remotion Motion Test

Steps:

1. Render same clip with direction disabled.
2. Render clip with direction enabled.
3. Compare output visually.

Pass criteria:

- directed output has visible motion.
- captions are not cropped or moved.
- no black frames.
- output duration matches compacted spans.
- camera beats happen at expected compacted timeline positions.

### Color Grade Test

Steps:

1. Render with `neutral`.
2. Render with `warm_contrast`.
3. Render with `whiteboard_clarity`.

Pass criteria:

- each preset changes appearance predictably.
- whiteboards/slides remain readable.
- skin tones are not destroyed.

### Music Test

Steps:

1. Generate music for a candidate.
2. Render with generated music.
3. Inspect loudness.

Pass criteria:

- music exists.
- music duration covers main clip.
- speech remains clear.
- music fades in/out.

### Fallback Test

Steps:

1. Force GPT to return invalid preset.
2. Validate plan.
3. Render.

Pass criteria:

- invalid preset is corrected.
- render succeeds.
- user sees validation warning.

### Idempotency Test

Steps:

1. Prepare rough cut for the same candidate twice.
2. Generate direction for the same rough cut twice.
3. Queue render twice with unchanged inputs.

Pass criteria:

- no duplicate rough cut artifacts.
- no duplicate valid direction plans for the same prompt/schema/template input.
- no duplicate render jobs for the same render signature.

### Cache Invalidation Test

Steps:

1. Render a clip.
2. Edit transcript text.
3. Change compaction spans.
4. Change direction plan.
5. Change generated music.

Pass criteria:

- each meaningful change creates a new render signature.
- unchanged retries reuse the existing valid artifact.

### Cost Control Test

Steps:

1. Create a long candidate over `MAX_ROUGH_DURATION_MS`.
2. Trigger direction generation repeatedly.
3. Use more frames than `MAX_DIRECTION_FRAMES`.

Pass criteria:

- rough cut is capped or rejected with a human-readable reason.
- GPT direction calls stop after the configured candidate cap.
- frame payload is clamped to the configured max.

## Safety Rules

- GPT never returns executable code.
- GPT never returns shell commands.
- GPT never returns arbitrary ffmpeg filters.
- Unknown presets are ignored.
- Render always has a fallback plan.
- Motion is limited by template settings.
- Music generation is disabled unless configured.
- Commercial licensing status must be stored for generated music.

## Recommended First Batch

Implement first:

- `EditDirectionPlan` types.
- DB tables and repository functions.
- validation layer.
- fallback plan.
- Remotion directed camera component using local mock data.
- compacted timeline duration fix.
- render signature hashing for direction/music/template/transcript/spans.

Reason:

- This proves the bridge from JSON to Remotion before involving GPT or music APIs.

Then implement:

- rough cut creation.
- frame extraction.
- low-res preview generation.
- idempotent artifact reuse.
- GPT director.

Then implement:

- music provider.
- UI review surface.
- face/scene guidance.

Do not implement GPT calls or music generation before the mock direction plan renders correctly through Remotion. The bridge from constrained JSON to deterministic render is the core risk to prove first.

## Sources And Notes

OpenAI vision/image inputs are suitable for visual review of sampled frames/contact sheets:

- `https://developers.openai.com/api/docs/guides/images-vision`

OpenAI video editing APIs exist, but uploaded-video editing may require eligibility and should not be the core dependency:

- `https://developers.openai.com/api/docs/guides/video-generation`

ElevenLabs Music API is a strong candidate for generated background score because it is positioned for commercial use and supports text-prompt music generation:

- `https://elevenlabs.io/music-api`

MusicAPI.ai is a possible secondary adapter after licensing review:

- `https://musicapi.ai/`

## Final Architecture Statement

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

That bridge is the reason this setup can work reliably.
