# Live Clip Factory

[![CI](https://github.com/jainam-ranka/my-clip-factory/actions/workflows/ci.yml/badge.svg)](https://github.com/jainam-ranka/my-clip-factory/actions/workflows/ci.yml)

Local-first livestream clipping studio built with Next.js, Remotion, SQLite,
`yt-dlp`, Whisper, and OpenAI.

Live Clip Factory turns long YouTube or X livestreams into reviewed short clips.
It downloads stream chunks, transcribes them locally, asks an OpenAI model to
find candidate moments, lets a human approve or adjust clips, and renders final
exports with dynamic captions.

## Features

- Rolling livestream ingestion with `yt-dlp`.
- Local transcription through `faster-whisper`, with optional `whisper.cpp`
  fallback.
- GPT-assisted clip candidate selection from recent transcript windows.
- Manual review and approval before rendering.
- Transcript-token editing for caption fixes.
- Remotion-based exports in vertical and horizontal formats.
- Render verification checks against transcript timing.
- Optional Google Drive upload for finished clips.

## Requirements

- Node.js 20 or newer.
- `npm`.
- `yt-dlp` available on your `PATH`.
- Python 3 if using `faster-whisper`.
- An OpenAI API key for AI clip scoring.

## Quick start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000.

Set at least:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4.1-mini
TRANSCRIPTION_LANGUAGE=en
```

## Main workflow

1. Paste a livestream URL into the dashboard.
2. Watch run status and rolling transcript updates.
3. Review AI-proposed candidate moments.
4. Approve or reject clips.
5. Render approved clips.
6. Download exports from local output storage or upload them to Google Drive.

## Local transcription

Recommended default:

```bash
python3 -m pip install faster-whisper
```

The app calls `scripts/transcribe_faster_whisper.py`.

Optional `whisper.cpp` fallback:

```bash
WHISPER_CPP_BIN=/absolute/path/to/whisper-cli
WHISPER_CPP_MODEL=/absolute/path/to/ggml-base.en.bin
```

## YouTube reliability

Some YouTube streams require browser cookies or visitor data. Configure one of:

```bash
YT_DLP_COOKIES_FROM_BROWSERS=safari,chrome
YT_DLP_COOKIES_FILE=/absolute/path/to/youtube-cookies.txt
YT_DLP_VISITOR_DATA=...
```

Only use cookies you are authorized to use. Keep cookie files out of Git.

## Google Drive exports

Google Drive upload is optional. Configure it only for a personal OAuth client
and a folder you control:

```bash
GOOGLE_DRIVE_PARENT_FOLDER_ID=your_drive_folder_id
GOOGLE_DRIVE_CLIENT_ID=your_oauth_client_id
GOOGLE_DRIVE_CLIENT_SECRET=your_oauth_client_secret
GOOGLE_DRIVE_REFRESH_TOKEN=your_oauth_refresh_token
```

## Useful commands

```bash
npm run dev
npm run lint
npm run build
npm run remotion:studio
```

## Data and privacy

The app is local-first. It creates local SQLite data, downloaded chunks,
runtime assets, and rendered media. These are intentionally ignored by Git:

- `.env.local`
- `data/`
- `storage/`
- `out/`
- `public/runtime/`
- `.next/`
- `node_modules/`

Do not commit real credentials, cookies, runtime databases, downloaded media,
or rendered output.

## Project status

This project is early and actively evolving. The strongest contribution areas
are reliability, setup docs, media-ingestion hardening, smaller test fixtures,
caption accuracy, and render verification.

See [ROADMAP.md](ROADMAP.md) for the near-term maintenance plan.
