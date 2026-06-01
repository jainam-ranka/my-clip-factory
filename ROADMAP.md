# Roadmap

Live Clip Factory is early OSS. The goal is to make local-first AI video
workflows reproducible, inspectable, and safe to run on a maintainer machine.

## Near term

- Add small fixture-based tests for transcript parsing, caption grouping, and
  render verification.
- Improve `yt-dlp` failure reporting for rate limits, unavailable streams, and
  cookie-related failures.
- Document common setup paths for `faster-whisper`, `whisper.cpp`, Remotion,
  and Google Drive exports.
- Add issue labels for ingestion, transcription, rendering, captions, docs, and
  security.

## Reliability

- Make worker state easier to inspect from the UI.
- Add safer retry behavior for transient download and transcription failures.
- Keep generated clips tied to source transcript spans for easier debugging.
- Build smaller reproducible examples for reported render/caption bugs.

## Security and privacy

- Continue keeping credentials, cookies, local databases, downloaded media, and
  rendered output outside Git.
- Review local file handling around uploads, downloads, and asset deletion.
- Harden optional Google Drive OAuth handling and document token rotation.
- Add explicit guidance for reporting issues that may expose local files or
  private media.

## AI-assisted workflows

- Improve clip-selection prompts with clearer scoring and rejection reasons.
- Add deterministic fixtures for evaluating model-assisted candidate selection.
- Use Codex to review pull requests, identify reliability regressions, and
  harden risky ingestion/rendering paths.
