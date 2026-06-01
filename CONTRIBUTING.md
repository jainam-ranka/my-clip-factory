# Contributing

Live Clip Factory is an early local-first video tooling project. Contributions
that improve reliability, setup, transcription accuracy, render correctness,
and contributor experience are welcome.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000.

## Before opening a pull request

```bash
npm run lint
npm run build
```

Keep generated media, local databases, `.env.local`, runtime assets, and build
output out of commits.

## Useful contribution areas

- Safer media ingestion and clearer `yt-dlp` failure handling.
- Better transcript-token editing and render verification.
- Smaller reproducible fixtures for clip selection and rendering tests.
- Documentation for local Whisper, whisper.cpp, Remotion, and Google Drive.
- Security hardening around local files, OAuth tokens, and worker boundaries.

## Maintainer expectations

Prefer small, reviewable changes. Include a short description of the workflow
tested and any video/transcription edge case the change covers.
