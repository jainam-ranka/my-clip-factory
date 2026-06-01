# Live Clip Factory Reliability, Audio-First Ingestion, and Dynamic Clipping Plan

## Goal

Rework Live Clip Factory so it reliably observes YouTube and X sources, analyzes speech quickly, proposes clip-worthy moments, and renders only approved clips with clean subtitles, templates, and conservative filler removal.

The target product behavior is:

- YouTube and X runs do not get stuck in fake `active` states.
- VOD sources download audio only until a clip is approved.
- Livestream sources keep enough local signal to analyze live, but final video is retained only for approved clip ranges.
- Approved clips can physically remove obvious filler words and long pauses without cutting speakers mid-word.
- Subtitles render one word at a time.
- Rendering always uses media that actually covers the requested timestamp range.
- Templates control the visual/audio style, including fonts from Google Fonts and system fonts.
- Approval requires choosing a template.
- No intro/outro asset is added unless the selected template explicitly includes one.
- Hyperframes influences future template/block architecture, but Remotion remains the renderer for this phase.

## Non-Goals

- No migration of old runs, old render jobs, or old run media.
- No replacement of Remotion with Hyperframes in this phase.
- No aggressive jump-cut editing by default.
- No deletion of existing templates.
- No attempt to bypass YouTube auth or bot checks without valid cookies/auth context.

## Current Problems

### 1. YouTube Live Capture Is Fragile

Current files:

- `src/lib/server/ytdlp.ts`
- `src/lib/server/source-metadata.ts`
- `src/lib/server/ingestion.ts`
- `src/lib/server/runtime.ts`

Issues:

- `source-metadata.ts` stores signed YouTube HLS playlist URLs.
- `ingestion.ts` later passes the cached playlist URL to `ffmpeg`.
- YouTube HLS URLs can expire while the run is still active.
- Metadata refresh currently happens too late for reliable live capture.
- Auth failures, visitor-data failures, rate limits, expired HLS URLs, and ended streams are not represented as clear run states.

### 2. Runs Can Stay Active After The Source Ends

Current files:

- `src/lib/server/runtime.ts`
- `src/lib/server/source-metadata.ts`
- `src/lib/server/repository.ts`

Issues:

- A run can remain `active` even when source metadata says `post_live`.
- Runtime error handling falls back to `active` for many capture failures.
- The UI then shows a run as alive when there is no useful work happening.

### 3. Rendering Can Use The Wrong Media Source

Current files:

- `src/lib/server/rendering.ts`
- `src/lib/server/fs.ts`
- `src/lib/server/repository.ts`

Issues:

- Rendering prefers `storage/<run>/source/source.mp4` if it exists.
- Some runs have a partial `source.mp4` plus later segment files.
- If a candidate starts after the partial source duration, `ffmpeg` produces an empty output.
- The render error looks like an ffmpeg failure, but the real issue is wrong media coverage selection.

### 4. VOD Ingestion Is Too Heavy

Current files:

- `src/lib/server/ingestion.ts`
- `src/lib/server/runtime.ts`
- `src/lib/server/transcription.ts`

Issues:

- The pipeline still behaves too much like video-first capture.
- For recorded videos, we do not need full video until a clip is approved.
- Downloading video early increases disk usage, heat, render confusion, and YouTube failure surface.

### 5. Livestream Retention Does Not Match The Desired Product

Current files:

- `src/lib/server/ingestion.ts`
- `src/lib/server/runtime.ts`
- `src/lib/server/fs.ts`

Desired behavior:

- Keep live analysis moving.
- Do not retain the full stream video.
- Retain final video only for approved segments.

Current challenge:

- To render later, the app needs access to video for the approved timestamp range.
- For live sources, if video is not kept at all, the approved moment may be gone by the time approval happens.
- The product needs a short-lived video cache for review/approval, then permanent retention only for approved clips.

### 6. Filler Removal Does Not Exist Yet

Current files:

- `src/lib/server/analyzer.ts`
- `src/lib/server/transcription.ts`
- `src/lib/server/rendering.ts`
- `src/lib/types.ts`

Issues:

- The analyzer returns one continuous `suggestedStart/suggestedEnd`.
- There is no model for multiple kept ranges.
- There is no filler-word classifier.
- There is no silence-aware cutting.
- Subtitles are word-timed, but rendered video/audio is not compacted.

### 7. Templates Do Not Support Real Font Families Yet

Current files:

- `src/components/templates-client.tsx`
- `src/app/api/templates/route.ts`
- `src/app/api/templates/[id]/route.ts`
- `src/lib/types.ts`
- `src/lib/server/db.ts`
- `src/lib/server/repository.ts`
- `src/lib/server/rendering.ts`
- `src/remotion/LiveClipComposition.tsx`

Issues:

- Templates support caption style and size, but not actual font family.
- The render currently hardcodes Archivo in the composition.
- The template UI does not list all Google Fonts or system fonts.

### 8. Old Dual-Format Paths Still Exist

Current files:

- `src/lib/server/runtime.ts`
- `src/lib/server/telegram-bot.ts`

Issues:

- Some helper paths still queue both `vertical` and `landscape`.
- Template layout should be the source of truth.

### 9. Product Behavior Needs To Stay Explicit

Current files:

- `src/components/run-detail-client.tsx`
- `src/components/templates-client.tsx`
- `src/remotion/LiveClipComposition.tsx`
- `src/lib/server/rendering.ts`
- `src/lib/server/runtime.ts`

Existing requirements to preserve:

- Pending clips are approved through a template selection flow.
- The template controls layout, caption style, caption size, caption color, caption placement, music, intro, and outro.
- No outro means no outro in the render.
- No intro means use the default black intro title card.
- The default intro card shows clip title and hook/subtitle.
- Intro fades out and main video fades in.
- Music plays only during the main clip.
- Music fades in and fades out according to template settings.
- Main clip visuals fade out at the end while speech audio remains intact.
- Pending clip title and hook can be edited before approval.
- Transcript words can be edited and future renders use edited text.
- Candidate transcript boundaries can be nudged by word from the transcript modal.
- Render progress is live-only and disappears after completion.
- Successfully rendered clips should leave pending state.

## Target Architecture

## Source Modes

### VOD Mode

Use audio-first ingestion.

Flow:

1. Inspect source metadata.
2. Download or extract audio only.
3. Transcribe audio.
4. Analyze transcript windows.
5. Generate clip candidates.
6. User approves candidate.
7. Download only the approved video range.
8. Apply conservative filler removal.
9. Render final clip.
10. Retain only approved source ranges and final exports.

### Live Mode

Use rolling audio-first analysis plus short-lived video cache.

Flow:

1. Inspect source metadata.
2. Capture rolling audio chunks for transcription.
3. Capture temporary rolling video chunks only long enough to support approval.
4. Analyze transcript windows every configured interval.
5. Generate candidates.
6. User approves candidate before retention expires.
7. Copy or download the approved source range into permanent clip storage.
8. Apply conservative filler removal.
9. Render final clip.
10. Delete non-approved rolling video chunks after retention window.

Recommended initial live retention:

- Keep temporary video chunks for `30 minutes`.
- Retain permanent media only for approved candidate ranges.
- Make the retention value configurable in `src/lib/config.ts`.

Reasoning:

- Keeping no temporary video at all would make live approval impossible if the platform no longer exposes the exact past range.
- Keeping a temporary rolling cache satisfies the user's goal: final retained videos are only approved segments.

## Subtitle Rendering

Subtitles should remain simple and deterministic.

Current desired behavior:

- Show exactly one active word at a time.
- Use the template-selected font family.
- Use the template-selected color for the active word.
- Use the template-selected placement.
- Hide subtitles during transcript gaps.
- Use edited transcript token text in all future renders.

Files:

- `src/remotion/LiveClipComposition.tsx`
- `src/lib/server/rendering.ts`
- `src/lib/types.ts`
- `src/lib/server/repository.ts`

Acceptance tests:

- Rendered clips show one word at a time.
- Edited transcript words appear in the render.
- No old word repeats during silent gaps.
- Caption placement changes when template placement changes.
- Caption color changes when template color changes.

## Template-Driven Approval Flow

The approval flow should be strict and predictable.

Rules:

- User must choose a template before approval.
- Template layout decides render layout.
- Template font decides render typography.
- Template intro asset is optional.
- Template outro asset is optional.
- Template music asset is optional.
- No selected outro means no outro sequence is rendered.
- No selected intro means the default black intro card is rendered.
- Per-clip title/hook edits remain allowed before approval.
- Template fields cannot be tweaked inside approval.

Files:

- `src/components/run-detail-client.tsx`
- `src/app/api/candidates/[id]/approve/route.ts`
- `src/lib/server/runtime.ts`
- `src/lib/server/repository.ts`
- `src/lib/server/rendering.ts`

Acceptance tests:

- Approval without template is blocked.
- Approval with landscape template queues only landscape.
- Approval with vertical template queues only vertical.
- Template with no outro produces no outro.
- Template with no intro produces black intro card.
- Edited title/hook appear in the intro card and rendered metadata.

## Database Plan

All migrations should be added inside `src/lib/server/db.ts`, following the existing lightweight SQLite migration style.

### New Or Updated Columns

#### `runs`

Add:

- `source_mode TEXT`
- `source_duration_ms INTEGER`
- `source_media_strategy TEXT`
- `analysis_audio_path TEXT`
- `temp_video_retention_ms INTEGER`
- `last_capture_error_code TEXT`

Suggested values:

- `source_mode`: `vod`, `live`, `unknown`
- `source_media_strategy`: `audio_first`, `rolling_live_cache`, `legacy_segment_video`
- `last_capture_error_code`: `needs_auth`, `rate_limited`, `stream_not_started`, `stream_ended`, `temporary_capture_error`, `unsupported_source`

#### `segments`

Clarify segment type and retention state.

Add:

- `media_type TEXT`
- `retention_status TEXT`
- `expires_at TEXT`

Suggested values:

- `media_type`: `audio`, `video`, `approved_video`
- `retention_status`: `temporary`, `retained`, `deleted`

#### `candidates`

Add compaction metadata.

Add:

- `compaction_status TEXT`
- `compaction_mode TEXT`
- `compact_start_ms INTEGER`
- `compact_end_ms INTEGER`

Suggested values:

- `compaction_status`: `pending`, `ready`, `disabled`, `error`
- `compaction_mode`: `conservative`

#### New Table: `clip_spans`

Stores the kept media ranges for a candidate.

Columns:

- `id TEXT PRIMARY KEY`
- `candidate_id TEXT NOT NULL`
- `run_id TEXT NOT NULL`
- `source_start_ms INTEGER NOT NULL`
- `source_end_ms INTEGER NOT NULL`
- `output_start_ms INTEGER NOT NULL`
- `output_end_ms INTEGER NOT NULL`
- `reason TEXT`
- `created_at TEXT NOT NULL`

Indexes:

- `idx_clip_spans_candidate`
- `idx_clip_spans_run`

#### `transcript_tokens`

Add speech-editing metadata.

Add:

- `token_kind TEXT`
- `is_filler INTEGER`
- `is_removed INTEGER`
- `edit_source TEXT`

Suggested values:

- `token_kind`: `word`, `punctuation`, `noise`
- `edit_source`: `transcriber`, `user`, `compactor`

#### `render_templates`

Add font family support.

Add:

- `font_family TEXT`
- `font_source TEXT`
- `subtitle_mode TEXT`

Suggested values:

- `font_source`: `google`, `system`
- `subtitle_mode`: `one_word`

#### `render_jobs`

Add render strategy metadata.

Add:

- `source_strategy TEXT`
- `clip_spans_json TEXT`

Suggested values:

- `source_strategy`: `continuous`, `compacted_spans`

#### New Table: `approved_media_ranges`

Tracks video ranges retained for approved candidates.

Columns:

- `id TEXT PRIMARY KEY`
- `run_id TEXT NOT NULL`
- `candidate_id TEXT NOT NULL`
- `source_start_ms INTEGER NOT NULL`
- `source_end_ms INTEGER NOT NULL`
- `video_path TEXT NOT NULL`
- `media_origin TEXT NOT NULL`
- `created_at TEXT NOT NULL`

Suggested values:

- `media_origin`: `vod_range_download`, `live_cache_copy`, `manual_upload`

Indexes:

- `idx_approved_media_candidate`
- `idx_approved_media_run`

## File-Level Implementation Plan

## Phase 1: Reliability First

### Files To Change

- `src/lib/server/source-metadata.ts`
- `src/lib/server/ytdlp.ts`
- `src/lib/server/ingestion.ts`
- `src/lib/server/runtime.ts`
- `src/lib/server/repository.ts`
- `src/lib/types.ts`
- `src/lib/config.ts`

### Work

1. Add normalized capture error codes.
2. Refresh YouTube live metadata immediately before each live capture.
3. Treat `post_live` and ended metadata as terminal.
4. Treat YouTube 429 and bot-check errors as `needs_auth` or `rate_limited`.
5. Add source-mode detection:
   - VOD if `isLive === false`.
   - Live if `isLive === true`.
   - Upcoming if `liveStatus === "is_upcoming"`.
6. Make active runs transition cleanly to:
   - `ready` when capture/analysis finished normally.
   - `error` when auth/rate-limit/unsupported source blocks progress.
   - `stopped` only when user stops it.

### Acceptance Tests

- Start a VOD YouTube run and confirm it does not remain `active` after full audio analysis.
- Start a YouTube live that has ended and confirm it becomes `ready` or `error`, not `active`.
- Start a YouTube URL that triggers bot-check and confirm UI shows `needs auth`.
- Start an X stream with no start-from-beginning support and confirm it records from current point without repeating the old `--live-from-start` failure.
- Stop a run manually and confirm it stays `stopped`.

## Phase 2: Audio-First VOD Ingestion

### Files To Change

- `src/lib/server/ingestion.ts`
- `src/lib/server/transcription.ts`
- `src/lib/server/runtime.ts`
- `src/lib/server/fs.ts`
- `src/lib/server/repository.ts`
- `src/lib/types.ts`

### Work

1. Add `downloadSourceAudio()` for VODs.
2. Store audio under:
   - `storage/<run-id>/source/source.m4a`
3. Segment audio locally for transcription.
4. Stop downloading VOD video during initial analysis.
5. Use audio coverage, not video coverage, to advance analysis.
6. Keep `captureCursorMs` meaning clear:
   - In VOD audio mode, it means analyzed audio coverage.
   - In live mode, it means observed live timeline coverage.

### Acceptance Tests

- Start a VOD run and confirm no full `source.mp4` is downloaded before approval.
- Confirm `source.m4a` exists.
- Confirm transcript tokens are created from audio.
- Confirm candidates are generated from audio-only analysis.
- Confirm disk usage is materially lower than full-video runs.

## Phase 3: Video-On-Approval

### Files To Change

- `src/lib/server/ingestion.ts`
- `src/lib/server/rendering.ts`
- `src/lib/server/runtime.ts`
- `src/lib/server/repository.ts`
- `src/lib/server/fs.ts`
- `src/app/api/candidates/[id]/approve/route.ts`

### Work

1. Add `downloadApprovedVideoRange()`.
2. For VODs, call `yt-dlp --download-sections` only after approval.
3. Store approved video source ranges under:
   - `storage/<run-id>/approved/<candidate-id>/source-range-000.mp4`
4. For live runs, copy retained rolling chunks into the approved folder.
5. Make rendering use approved media first.
6. Remove the current unconditional preference for `source/source.mp4`.
7. Validate media coverage before trim/render.

### Acceptance Tests

- Approve a VOD candidate and confirm only that candidate's video range downloads.
- Approve a live candidate within retention and confirm its video chunks become retained.
- Try rendering a range beyond available media and confirm the error is human-readable.
- Confirm no render uses partial `source.mp4` unless it fully covers the candidate range.

## Phase 4: Conservative Filler Removal

### Files To Change

- `src/lib/server/analyzer.ts`
- `src/lib/server/transcription.ts`
- `src/lib/server/rendering.ts`
- `src/lib/server/repository.ts`
- `src/lib/types.ts`
- `src/remotion/LiveClipComposition.tsx`

### Work

1. Add deterministic filler detection.
2. Add silence/pause detection with ffmpeg audio analysis.
3. Add conservative keep-span generation.
4. Never cut through a spoken word.
5. Only cut at safe audio boundaries:
   - gap must be above a configurable threshold.
   - boundary should occur after word end and before next word start.
   - avoid cuts if the next word starts too quickly.
6. Preserve filler words when speech is too fast to cut cleanly.
7. Store final kept spans in `clip_spans`.
8. Build rendered source by concatenating kept spans.
9. Rebase captions to compacted output time.

### Default Conservative Rules

Initial filler words:

- `um`
- `uh`
- `erm`
- `ah`
- `like`
- `you know`
- `i mean`
- repeated immediate duplicate words

Initial safe cut thresholds:

- Minimum silence gap: `300ms`
- Preferred silence gap: `450ms`
- Minimum kept span duration: `1200ms`
- Minimum distance from word boundary: `80ms`

Rules:

- Do not cut if it would remove the start or end of a real word.
- Do not cut if speaker cadence is too fast.
- Do not remove filler if it would make the sentence unnatural.
- Do not remove fillers inside named phrases, product names, or quotes.

### Acceptance Tests

- A clip with `um` surrounded by silence removes the filler from video/audio.
- A clip with fast speech keeps the filler rather than making an abrupt cut.
- Captions remain synced after compaction.
- Final clip duration is shorter when safe fillers are removed.
- No word is cut halfway.
- A/B manual check confirms the edited clip sounds natural.

## Phase 5: Template Fonts

### Files To Change

- `src/components/templates-client.tsx`
- `src/app/api/templates/route.ts`
- `src/app/api/templates/[id]/route.ts`
- `src/lib/types.ts`
- `src/lib/server/db.ts`
- `src/lib/server/repository.ts`
- `src/lib/server/rendering.ts`
- `src/remotion/LiveClipComposition.tsx`
- New file: `src/lib/fonts.ts`
- Optional new script: `scripts/build-font-registry.ts`

### Work

1. Add `fontFamily` and `fontSource` to templates and render config.
2. Build a font registry:
   - Google Fonts first from `@remotion/google-fonts`.
   - System fonts second from a curated local list.
3. Add searchable font picker in `/templates`.
4. Preview selected font in template cards.
5. Load selected Google font in Remotion.
6. Use CSS/system font fallback for system fonts.
7. Keep `Archivo` as default.
8. Persist `subtitleMode = "one_word"` for forward compatibility.

### Google Fonts Implementation Options

Preferred:

- Generate a curated registry from `@remotion/google-fonts/package.json`.
- Start with a practical list of high-quality fonts, then expand.

Avoid:

- Importing every font in `LiveClipComposition.tsx`.
- Rendering a giant native `<select>` with hundreds of fonts.

### Acceptance Tests

- Template creation lists Google Fonts first.
- Template creation lists system fonts after Google Fonts.
- Searching `Archivo` finds Archivo.
- Searching `Sora`, `Inter`, `Space Grotesk`, `Bebas Neue`, and `Anton` works if available.
- Rendered subtitles use selected font.
- Rendered intro title uses selected font.
- Existing templates without font fields default to Archivo.
- Existing templates without subtitle mode default to one-word subtitles.

## Phase 6: Remove Old Dual-Format Behavior

### Files To Change

- `src/lib/server/runtime.ts`
- `src/lib/server/telegram-bot.ts`
- `src/app/api/candidates/[id]/approve/route.ts`
- `src/components/run-detail-client.tsx`

### Work

1. Template `videoLayout` becomes the only layout source for approvals.
2. Remove or update helpers that queue both `vertical` and `landscape`.
3. Manual render should require template selection or explicitly choose layout.
4. Telegram auto-render paths should use template layout.

### Acceptance Tests

- Approving a landscape template creates only one landscape render.
- Approving a vertical template creates only one vertical render.
- No hidden codepath queues both formats unless explicitly requested.

## Phase 7: Hyperframes-Inspired Template Blocks

Hyperframes repo:

- `https://github.com/heygen-com/hyperframes`

Use Hyperframes as inspiration only in this phase.

### What To Borrow

- Block-based visual thinking.
- HTML/CSS-first animated composition concepts.
- Reusable title cards, overlays, transitions, and caption blocks.
- Catalog-style previews for templates.

### What Not To Do Yet

- Do not replace Remotion.
- Do not introduce a second renderer.
- Do not migrate existing render jobs.

### Future Block Model

Potential blocks:

- `intro_card`
- `caption_style`
- `lower_third`
- `background_treatment`
- `transition`
- `outro`
- `logo_bug`
- `music_bed`

Potential files later:

- `src/lib/template-blocks.ts`
- `src/remotion/blocks/IntroCard.tsx`
- `src/remotion/blocks/Captions.tsx`
- `src/remotion/blocks/LowerThird.tsx`
- `src/remotion/blocks/Outro.tsx`

### Acceptance Tests

- Template previews feel closer to final rendered output.
- Intro/caption/outro styles are reusable without duplicating composition code.
- Existing templates continue rendering in Remotion.

## Phase 8: UI And Operator Experience

### Files To Change

- `src/app/page.tsx`
- `src/app/runs/page.tsx`
- `src/app/runs/[id]/page.tsx`
- `src/components/run-detail-client.tsx`
- `src/components/templates-client.tsx`
- `src/app/globals.css`

### Work

1. Keep overview pages lightweight.
2. Keep each run on a dedicated control page.
3. Show source mode:
   - `VOD audio-first`
   - `Live rolling`
   - `Needs auth`
   - `Ended`
4. Show pending clips separately from rendered videos.
5. Keep rendered videos playable from the browser.
6. Show human-readable errors.
7. Keep transcript editing available in full transcript and candidate transcript modal.
8. Make candidate boundary nudging obvious and safe.
9. Add media retention status to run detail.

### Acceptance Tests

- Home page loads without starting heavy runtime work.
- Run detail page shows source mode and capture state.
- User can edit title/hook before approval.
- User can edit transcript words before render.
- User can nudge candidate transcript boundaries.
- Rendered video `Play` opens a playable stream.
- Errors do not show raw stack traces by default.

## Required API Changes

### Existing APIs To Update

- `POST /api/runs`
  - Detect source mode.
  - Initialize audio-first strategy for VODs.

- `GET /api/runs/[id]`
  - Include source mode.
  - Include media strategy.
  - Include capture error code.
  - Include compaction status.

- `POST /api/candidates/[id]/approve`
  - Ensure approved media is downloaded/retained.
  - Generate clip spans before render.
  - Queue render using template layout only.

- `PATCH /api/candidates/[id]`
  - Keep support for title/hook edits.
  - Re-run compaction if candidate bounds change.

- `PATCH /api/transcript-tokens/[id]`
  - Preserve user edits.
  - Mark edited token source.

- `POST /api/templates`
  - Add `fontFamily`.
  - Add `fontSource`.

- `PATCH /api/templates/[id]`
  - Add `fontFamily`.
  - Add `fontSource`.

### Potential New APIs

- `POST /api/candidates/[id]/compact`
  - Rebuild compact spans.

- `POST /api/candidates/[id]/prepare-media`
  - Download or retain approved video range.

- `GET /api/fonts`
  - Return Google and system font options.

- `GET /api/runs/[id]/media`
  - Return retained approved media ranges and temporary live cache status.

## Required Config Changes

File:

- `src/lib/config.ts`

Add:

- `LIVE_VIDEO_RETENTION_MS`
- `VOD_AUDIO_FORMAT`
- `FILLER_REMOVAL_MODE`
- `MIN_SAFE_CUT_SILENCE_MS`
- `PREFERRED_SAFE_CUT_SILENCE_MS`
- `MIN_KEEP_SPAN_MS`
- `ENABLE_AUDIO_FIRST_VOD`
- `ENABLE_COMPACTED_RENDERING`
- `SUBTITLE_MODE`
- `DEFAULT_TEMPLATE_FONT_FAMILY`
- `DEFAULT_TEMPLATE_FONT_SOURCE`

Recommended defaults:

- `LIVE_VIDEO_RETENTION_MS = 30 * 60_000`
- `VOD_AUDIO_FORMAT = "m4a"`
- `FILLER_REMOVAL_MODE = "conservative"`
- `MIN_SAFE_CUT_SILENCE_MS = 300`
- `PREFERRED_SAFE_CUT_SILENCE_MS = 450`
- `MIN_KEEP_SPAN_MS = 1200`
- `ENABLE_AUDIO_FIRST_VOD = true`
- `ENABLE_COMPACTED_RENDERING = true`
- `SUBTITLE_MODE = "one_word"`
- `DEFAULT_TEMPLATE_FONT_FAMILY = "Archivo"`
- `DEFAULT_TEMPLATE_FONT_SOURCE = "google"`

## Storage Layout

### VOD Runs

Desired layout:

```text
storage/<run-id>/
  source/
    source.m4a
    source-metadata.json
  transcripts/
    segment-00000.json
  approved/
    <candidate-id>/
      source-range-000.mp4
      compact-range-000.mp4
      concat.txt
```

### Live Runs

Desired layout:

```text
storage/<run-id>/
  live-audio/
    audio-00000.m4a
  live-video-cache/
    segment-00000.mp4
  transcripts/
    segment-00000.json
  approved/
    <candidate-id>/
      source-range-000.mp4
      compact-range-000.mp4
      concat.txt
```

### Final Renders

Keep current final export pattern:

```text
out/renders/<run-slug>/
  <clip-name>-<layout>-<signature>.mp4
```

## Testing Plan

## Unit-Level Tests

Add tests for:

- source mode detection.
- capture error classification.
- media coverage selection.
- filler detection.
- safe cut boundary detection.
- caption time rebasing.
- template font serialization.

Potential files:

- `src/lib/server/source-metadata.test.ts`
- `src/lib/server/runtime.test.ts`
- `src/lib/server/rendering.test.ts`
- `src/lib/server/compaction.test.ts`
- `src/lib/fonts.test.ts`

## Integration Tests

### VOD Audio-First Test

Goal:

- Confirm VOD analysis happens without downloading full video.

Steps:

1. Start a VOD run.
2. Confirm `source/source.m4a` exists.
3. Confirm `source/source.mp4` does not exist before approval.
4. Wait for transcript tokens.
5. Confirm candidates appear.
6. Approve one candidate.
7. Confirm only approved video range downloads.
8. Confirm final render succeeds.

Pass criteria:

- No full VOD video download before approval.
- Transcript generated.
- Candidate generated.
- Approved video range retained.
- Final export playable.

### YouTube Live Reliability Test

Goal:

- Confirm live capture handles metadata refresh and end-of-stream correctly.

Steps:

1. Start a currently live YouTube URL.
2. Confirm metadata is refreshed before capture.
3. Confirm audio transcript begins.
4. Confirm temporary video chunks are created.
5. Approve one candidate.
6. Confirm approved video range is retained.
7. Stop stream or use ended source.
8. Confirm run exits `active`.

Pass criteria:

- No stale HLS URL loop.
- No fake `active` run after source ends.
- Approved clip renders.

### X Live Test

Goal:

- Confirm X does not use `--live-from-start`.

Steps:

1. Start X live URL.
2. Confirm capture starts from current point.
3. Confirm no repeated `--live-from-start` error.
4. Approve a candidate.
5. Confirm render succeeds.

Pass criteria:

- X run progresses.
- Candidate can render if within retention.

### Conservative Filler Removal Test

Goal:

- Confirm filler removal is useful but not destructive.

Fixture:

- Audio/video sample with:
  - clear `um`
  - clear `you know`
  - one long pause
  - one fast filler that should not be removed

Steps:

1. Transcribe sample.
2. Generate candidate.
3. Run compaction.
4. Render compacted clip.
5. Compare original vs compacted duration.
6. Listen for abrupt cuts.

Pass criteria:

- Clear fillers removed.
- Fast filler kept.
- No chopped words.
- Captions synced.

### Template Font Test

Goal:

- Confirm template fonts are selectable and render correctly.

Steps:

1. Create template with Google Font.
2. Render clip.
3. Create template with system font.
4. Render clip.
5. Confirm visual output reflects font choice.

Pass criteria:

- Font picker works.
- Template saves font.
- Render uses font.
- Default remains Archivo.

### Subtitle Mode Test

Goal:

- Confirm all template renders use one-word subtitles.

Steps:

1. Render a clip with a dense transcript.
2. Inspect several moments in the output.
3. Confirm only one word appears at any frame.
4. Inspect a silent gap.
5. Confirm no subtitle repeats during the gap.

Pass criteria:

- One word visible at a time.
- No repeated stale captions.
- No phrase-sized caption groups.

### Render Source Selection Test

Goal:

- Confirm renderer picks media that covers candidate range.

Steps:

1. Create run with partial `source.mp4` and later segments.
2. Create candidate beyond `source.mp4` duration.
3. Render.

Pass criteria:

- Renderer does not use partial source.
- Renderer uses segments or fails clearly.
- No empty ffmpeg output.

## Manual QA Checklist

- Create VOD run.
- Create YouTube live run.
- Create X live run.
- Approve candidate from each.
- Use template with no outro.
- Use template with outro.
- Use template with Google Font.
- Use template with system font.
- Edit transcript word before approval.
- Edit candidate title and hook.
- Approve clip with conservative compaction.
- Confirm rendered video has one-word subtitles.
- Confirm no speaker word is cut halfway.
- Confirm storage contains only expected approved video ranges.
- Confirm stopped/ended runs are not `active`.
- Confirm no template adds outro unless an outro asset is selected.
- Confirm default black intro card appears when no intro asset is selected.
- Confirm template-selected font appears in rendered intro and captions.

## Milestones

### Milestone 1: Capture Reliability

Deliverables:

- Normalized source modes.
- Better YouTube metadata refresh.
- Better auth/rate-limit/end-state handling.
- No fake active runs.

Exit criteria:

- YouTube live/VOD/X runs transition correctly.
- Bad auth produces actionable UI error.

### Milestone 2: Correct Render Media Selection

Deliverables:

- Coverage-aware render source picker.
- No blind `source.mp4` preference.
- Human-readable render source errors.

Exit criteria:

- Late candidates render from valid segment media.
- Empty ffmpeg output failure class is removed.

### Milestone 3: Audio-First VOD

Deliverables:

- VOD audio-only source download.
- Transcript generation from audio.
- Video downloaded only after approval.

Exit criteria:

- No VOD video exists before approval.
- Approved clips still render successfully.

### Milestone 4: Live Rolling Retention

Deliverables:

- Live audio analysis.
- Temporary video retention.
- Approved segment retention.
- Cleanup of unapproved video chunks.

Exit criteria:

- Live analysis works.
- Only approved video ranges are retained permanently.

### Milestone 5: Conservative Dynamic Clipping

Deliverables:

- Filler classifier.
- Safe audio-boundary cut detection.
- `clip_spans` persistence.
- Multi-span render concat.
- Caption rebasing.

Exit criteria:

- Conservative filler removal works without abrupt cuts.

### Milestone 6: Font-Complete Templates

Deliverables:

- Google Fonts first.
- System fonts second.
- Searchable font picker.
- Template font persistence.
- Render font application.

Exit criteria:

- Templates fully control typography.

### Milestone 7: Hyperframes-Inspired Blocks

Deliverables:

- Template block model.
- Cleaner preview architecture.
- Reusable Remotion blocks.

Exit criteria:

- Visual system becomes easier to extend without changing the core renderer.

## Risks And Mitigations

### Risk: YouTube Auth Still Fails

Mitigation:

- Surface `needs_auth` clearly.
- Prefer cookies file if configured.
- Fall back to browser cookies.
- Do not loop endlessly on blocked sources.

### Risk: Audio-First VOD Cannot Later Download Exact Range

Mitigation:

- Keep source URL and metadata.
- On approval, retry with authenticated `yt-dlp`.
- If range download fails, offer clear retry/auth error.

### Risk: Live Approved Range Expires Before Approval

Mitigation:

- Keep temporary live video cache for `30 minutes`.
- Show candidates with expiration state later if needed.

### Risk: Filler Removal Sounds Choppy

Mitigation:

- Conservative default.
- Cut only at silence/low-energy gaps.
- Preserve fillers in fast speech.
- Keep original candidate range available for retry.

### Risk: Too Many Fonts Hurt UX

Mitigation:

- Searchable combobox.
- Google Fonts grouped first.
- System fonts grouped second.
- Default common fonts pinned at top.

### Risk: Render Complexity Increases

Mitigation:

- Introduce compaction behind a feature flag.
- Keep continuous render path as fallback.
- Add unit tests for span rebasing.

## Self-Review Against Requirements

Requirement: Reliability first.

- Satisfied by milestones 1 and 2 coming before audio-first and creative features.

Requirement: VOD audio only until approval.

- Satisfied by Phase 2 and Phase 3.

Requirement: Livestreams retain only approved videos.

- Satisfied with rolling temporary cache plus permanent retention only for approved ranges.

Requirement: Filler removal physically cuts final video/audio.

- Satisfied by `clip_spans`, multi-span rendering, and caption rebasing.

Requirement: Do not cut speakers halfway.

- Satisfied by safe boundary thresholds and word-boundary constraints.

Requirement: Conservative default.

- Satisfied by default compaction rules.

Requirement: Global filler default, not template-owned.

- Satisfied by config-level `FILLER_REMOVAL_MODE`.

Requirement: Both Google Fonts and system fonts, Google first.

- Satisfied by Phase 5.

Requirement: One-word subtitles.

- Satisfied by the subtitle rendering section, template subtitle mode, and subtitle tests.

Requirement: Template-driven approval.

- Satisfied by the template-driven approval flow and old dual-format cleanup.

Requirement: No unselected outro.

- Satisfied by template rules and approval tests.

Requirement: Hyperframes inspiration only.

- Satisfied by Phase 7, keeping Remotion as renderer.

Requirement: No migration needed.

- Satisfied by non-goals and future-only architecture.

Requirement: All files, repos, DB changes, milestones, tests.

- Satisfied by file-level plan, DB plan, external repo note, milestones, and test plan.

## Recommended First Implementation Batch

Batch 1 should include only:

- source mode normalization.
- YouTube metadata refresh before live capture.
- run lifecycle fixes.
- render source coverage validation.

Files:

- `src/lib/server/source-metadata.ts`
- `src/lib/server/ytdlp.ts`
- `src/lib/server/ingestion.ts`
- `src/lib/server/runtime.ts`
- `src/lib/server/rendering.ts`
- `src/lib/server/repository.ts`
- `src/lib/types.ts`
- `src/lib/config.ts`

Reason:

- These fixes remove the core instability before changing the ingestion architecture.

Batch 2 should include:

- VOD audio-first ingestion.
- approved video range download.
- storage layout updates.

Batch 3 should include:

- conservative filler removal.
- clip spans.
- compacted rendering.

Batch 4 should include:

- all-font templates.
- Hyperframes-inspired block cleanup.

Batch 5 should include:

- run detail UI state cleanup.
- source mode badges.
- retained media visibility.
- cleaner candidate boundary controls.

## Implementation Status

Implemented in this pass:

- Added source-mode, source-duration, source-media-strategy, analysis-audio, live-retention, and capture-error fields to `runs`.
- Added media type, retention status, and expiry metadata to `segments`.
- Added compaction metadata to `candidates`, `clip_spans`, and `approved_media_ranges`.
- Added transcript edit/filler metadata to `transcript_tokens`.
- Added template font fields and one-word subtitle mode to `render_templates`.
- Added render source strategy and clip-span metadata to `render_jobs`.
- Added source-mode detection from yt-dlp metadata and normalized capture error codes.
- Refreshed live metadata before live capture and treated ended/post-live states as terminal instead of fake active work.
- Added VOD audio-first ingestion via `source/source.m4a`; VOD analysis segments are extracted from audio.
- Added video-on-approval range download for VOD candidates under `storage/<run-id>/approved/<candidate-id>/`.
- Removed blind render preference for `source/source.mp4`; rendering now checks approved media first, then validates segment coverage.
- Added conservative deterministic filler-span generation, persisted clip spans, multi-span concat rendering, and caption time rebasing.
- Kept one-word subtitles and silent-gap hiding in Remotion.
- Added template font persistence, a Google-first/system-second font registry, `/api/fonts`, template UI font picker, and Remotion font application.
- Changed approval and Telegram approval to queue only the selected template layout.
- Added run-detail source mode, media strategy, and retention status.

Verification completed:

- `npm run build` passes.
- `npm run lint` passes.
- `GET /api/fonts` returns Google fonts first and system fonts second.
- `GET /api/templates` loads existing templates with default `Archivo`, `google`, and `one_word` fields populated by migration.
- `GET /runs` renders successfully from the local dev server.

Manual QA still required with real sources:

- Start a fresh VOD run and confirm `source/source.m4a` exists and no full `source/source.mp4` is created before approval.
- Approve a VOD candidate and confirm only the approved range downloads.
- Approve a live candidate within retention and confirm retained media covers the approved range.
- Listen to a compacted clip to confirm conservative filler cuts are natural.
- Render Google-font and system-font templates and visually confirm typography.
