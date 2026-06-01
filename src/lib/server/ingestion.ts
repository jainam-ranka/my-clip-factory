import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SEGMENT_MS, VOD_AUDIO_FORMAT } from "@/lib/config";
import { detectPlatform, toFfmpegTimestamp, toSectionTimestamp } from "@/lib/utils";
import { runCommand, throwIfAborted } from "./process";
import type { SourceMetadata } from "./source-metadata";
import { runYtDlpWithFallbacks } from "./ytdlp";

const BEST_VIDEO_FORMAT_ARGS = [
  "-f",
  "bestvideo*+bestaudio/best",
  "--format-sort",
  "res,fps,vbr,abr",
];

function findMatchingRawFile(outputDir: string, segmentIndex: number) {
  const prefix = `segment-${String(segmentIndex).padStart(5, "0")}-raw`;
  const matches = fs.readdirSync(outputDir)
    .filter((file) => file.startsWith(prefix))
    .map((file) => path.join(outputDir, file))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    });

  return matches[0] ?? null;
}

function hasUsableRawFile(rawPath: string | null) {
  if (!rawPath) {
    return false;
  }

  try {
    return fs.existsSync(rawPath) && fs.statSync(rawPath).size > 250_000;
  } catch {
    return false;
  }
}

export async function getMediaDurationMs(filePath: string) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    return null;
  }

  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], process.cwd(), { timeoutMs: 15_000 });

  const durationSeconds = Number(result.stdout.trim());
  return result.exitCode === 0 && Number.isFinite(durationSeconds)
    ? Math.round(durationSeconds * 1000)
    : null;
}

async function hasAudioStream(filePath: string) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    return false;
  }

  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "csv=p=0",
    filePath,
  ], process.cwd(), { timeoutMs: 15_000 });

  return result.exitCode === 0 && result.stdout.trim().includes("audio");
}

async function canDecodeAudio(filePath: string) {
  if (!(await hasAudioStream(filePath))) {
    return false;
  }

  const result = await runCommand("ffmpeg", [
    "-v",
    "error",
    "-xerror",
    "-i",
    filePath,
    "-map",
    "0:a:0",
    "-t",
    "20",
    "-f",
    "null",
    "-",
  ], process.cwd(), { timeoutMs: 30_000 });

  return result.exitCode === 0;
}

function findNewestFile(dir: string) {
  if (!fs.existsSync(dir)) {
    return null;
  }

  const files = fs.readdirSync(dir)
    .map((file) => path.join(dir, file))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
      } catch {
        return false;
      }
    })
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);

  return files[0] ?? null;
}

async function transcodeAudioToM4a(inputPath: string, outputPath: string, signal?: AbortSignal) {
  const tempOutputPath = `${outputPath}.tmp-${Date.now()}.m4a`;
  fs.rmSync(tempOutputPath, { force: true });

  const result = await runCommand("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-xerror",
    "-i",
    inputPath,
    "-vn",
    "-map",
    "0:a:0",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    tempOutputPath,
  ], process.cwd(), {
    timeoutMs: 30 * 60_000,
    signal,
  });

  if (result.exitCode !== 0 || !(await canDecodeAudio(tempOutputPath))) {
    fs.rmSync(tempOutputPath, { force: true });
    throw new Error(result.stderr || "Downloaded source audio could not be normalized.");
  }

  fs.rmSync(outputPath, { force: true });
  fs.renameSync(tempOutputPath, outputPath);
}

export async function captureSegment(input: {
  url: string;
  outputDir: string;
  segmentIndex: number;
  startMs: number;
  sourceMetadata?: SourceMetadata | null;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const platform = detectPlatform(input.url);
  if (platform === "youtube" && input.sourceMetadata?.isLive && input.sourceMetadata.liveCapture) {
    return captureYoutubeLiveSegment({
      outputDir: input.outputDir,
      segmentIndex: input.segmentIndex,
      startMs: input.startMs,
      liveCapture: input.sourceMetadata.liveCapture,
      signal: input.signal,
    });
  }

  const rawTemplatePath = path.join(
    input.outputDir,
    `segment-${String(input.segmentIndex).padStart(5, "0")}-raw.%(ext)s`,
  );
  const finalPath = path.join(input.outputDir, `segment-${String(input.segmentIndex).padStart(5, "0")}.mp4`);
  const start = toSectionTimestamp(input.startMs);
  const end = toSectionTimestamp(input.startMs + SEGMENT_MS);
  const liveModeAttempts =
    input.sourceMetadata?.isLive === false
      ? [[]]
      : platform === "x"
      ? [["--no-live-from-start"]]
      : [["--live-from-start"], ["--no-live-from-start"]];
  const formatAttempts = [
    BEST_VIDEO_FORMAT_ARGS,
    [],
  ];
  const attemptErrors: string[] = [];
  let ytdlp = null as Awaited<ReturnType<typeof runYtDlpWithFallbacks>>["result"] | null;
  let rawPath = null as string | null;

  outer:
  for (const liveArgs of liveModeAttempts) {
    for (const formatArgs of formatAttempts) {
      let result;
      try {
        ({ result } = await runYtDlpWithFallbacks({
          url: input.url,
          args: [
            ...liveArgs,
            "--no-playlist",
            "--download-sections",
            `*${start}-${end}`,
            "--force-overwrites",
            "--no-part",
            "--merge-output-format",
            "mp4",
            ...formatArgs,
            "-o",
            rawTemplatePath,
          ],
          timeoutMs: 90_000,
          signal: input.signal,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown yt-dlp error.";
        attemptErrors.push(message);
        continue;
      }

      const matchedRawFile = findMatchingRawFile(input.outputDir, input.segmentIndex);
      if (result.exitCode === 0 || (result.timedOut && hasUsableRawFile(matchedRawFile))) {
        ytdlp = result;
        rawPath = matchedRawFile;
        break outer;
      }

      attemptErrors.push(result.stderr || result.stdout || "Unknown yt-dlp error.");
    }
  }

  if (!ytdlp) {
    throw new Error(attemptErrors.join("\n\n----\n\n") || "yt-dlp failed to download a live section.");
  }
  if (!hasUsableRawFile(rawPath)) {
    throw new Error("yt-dlp finished without leaving a usable media file for this segment.");
  }
  if (!rawPath) {
    throw new Error("yt-dlp completed but no raw segment path could be resolved.");
  }

  const resolvedRawPath = rawPath;
  fs.copyFileSync(resolvedRawPath, finalPath);

  return {
    rawPath: resolvedRawPath,
    finalPath,
    endMs: input.startMs + SEGMENT_MS,
  };
}

async function captureYoutubeLiveSegment(input: {
  outputDir: string;
  segmentIndex: number;
  startMs: number;
  liveCapture: NonNullable<SourceMetadata["liveCapture"]>;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const rawPath = path.join(
    input.outputDir,
    `segment-${String(input.segmentIndex).padStart(5, "0")}-raw.mp4`,
  );
  const finalPath = path.join(input.outputDir, `segment-${String(input.segmentIndex).padStart(5, "0")}.mp4`);
  const headers = Object.entries(input.liveCapture.headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\r\n");

  const args = [
    "-y",
    "-nostdin",
    "-user_agent",
    input.liveCapture.headers["User-Agent"] ?? "Mozilla/5.0",
  ];

  if (headers) {
    args.push("-headers", `${headers}\r\n`);
  }

  args.push(
    "-live_start_index",
    "0",
    "-ss",
    toFfmpegTimestamp(input.startMs),
    "-i",
    input.liveCapture.playlistUrl,
    "-t",
    toFfmpegTimestamp(SEGMENT_MS),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    rawPath,
  );

  const result = await runCommand("ffmpeg", args, process.cwd(), {
    timeoutMs: 4 * 60_000,
    signal: input.signal,
  });

  if (result.exitCode !== 0 || !fs.existsSync(rawPath) || fs.statSync(rawPath).size < 250_000) {
    throw new Error(result.stderr || "ffmpeg could not capture the YouTube live DVR segment.");
  }

  fs.copyFileSync(rawPath, finalPath);

  return {
    rawPath,
    finalPath,
    endMs: input.startMs + SEGMENT_MS,
  };
}

export async function downloadFullSourceVideo(input: {
  url: string;
  outputPath: string;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const outputTemplate = input.outputPath.replace(/\.mp4$/i, ".%(ext)s");

  const { result } = await runYtDlpWithFallbacks({
    url: input.url,
    args: [
      "--no-playlist",
      "--force-overwrites",
      "--no-part",
      "--merge-output-format",
      "mp4",
      ...BEST_VIDEO_FORMAT_ARGS,
      "-o",
      outputTemplate,
    ],
    timeoutMs: 2 * 60 * 60_000,
    signal: input.signal,
  });

  if (result.exitCode !== 0 || !fs.existsSync(input.outputPath)) {
    throw new Error(result.stderr || result.stdout || "yt-dlp failed to download the full source video.");
  }

  return input.outputPath;
}

export async function downloadSourceAudio(input: {
  url: string;
  outputPath: string;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const outputDir = path.dirname(input.outputPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-factory-audio-"));
  const tempTemplate = path.join(tempDir, "source.%(ext)s");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(input.outputPath, { force: true });

  try {
    const { result } = await runYtDlpWithFallbacks({
      url: input.url,
      args: [
        "--no-playlist",
        "--force-overwrites",
        "--no-part",
        "-f",
        "bestaudio/best",
        "-o",
        tempTemplate,
      ],
      timeoutMs: 90 * 60_000,
      signal: input.signal,
    });

    const downloadedPath = findNewestFile(tempDir);
    if (result.exitCode !== 0 || !downloadedPath || !(await hasAudioStream(downloadedPath))) {
      throw new Error(result.stderr || result.stdout || "yt-dlp failed to download source audio.");
    }

    if (VOD_AUDIO_FORMAT.toLowerCase() === "m4a") {
      await transcodeAudioToM4a(downloadedPath, input.outputPath, input.signal);
    } else {
      const finalPath = input.outputPath.replace(/\.[^.]+$/i, `.${VOD_AUDIO_FORMAT}`);
      fs.rmSync(finalPath, { force: true });
      fs.copyFileSync(downloadedPath, finalPath);
      if (!(await canDecodeAudio(finalPath))) {
        fs.rmSync(finalPath, { force: true });
        throw new Error("Downloaded source audio could not be decoded.");
      }
      return finalPath;
    }

    return input.outputPath;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function downloadApprovedVideoRange(input: {
  url: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const outputTemplate = input.outputPath.replace(/\.mp4$/i, ".%(ext)s");
  const start = toSectionTimestamp(input.startMs);
  const end = toSectionTimestamp(input.endMs);

  const { result } = await runYtDlpWithFallbacks({
    url: input.url,
    args: [
      "--no-playlist",
      "--download-sections",
      `*${start}-${end}`,
      "--force-keyframes-at-cuts",
      "--force-overwrites",
      "--no-part",
      "--merge-output-format",
      "mp4",
      ...BEST_VIDEO_FORMAT_ARGS,
      "-o",
      outputTemplate,
    ],
    timeoutMs: 45 * 60_000,
    signal: input.signal,
  });

  if (result.exitCode !== 0 || !fs.existsSync(input.outputPath) || fs.statSync(input.outputPath).size === 0) {
    throw new Error(result.stderr || result.stdout || "yt-dlp failed to download the approved video range.");
  }

  return input.outputPath;
}

export async function captureSegmentFromSourceFile(input: {
  sourcePath: string;
  outputDir: string;
  segmentIndex: number;
  startMs: number;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const finalPath = path.join(input.outputDir, `segment-${String(input.segmentIndex).padStart(5, "0")}.mp4`);
  const durationMs = SEGMENT_MS;

  const result = await runCommand("ffmpeg", [
    "-y",
    "-ss",
    toSectionTimestamp(input.startMs),
    "-i",
    input.sourcePath,
    "-t",
    toSectionTimestamp(durationMs),
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    finalPath,
  ], process.cwd(), {
    timeoutMs: 8 * 60_000,
    signal: input.signal,
  });

  if (result.exitCode !== 0 || !fs.existsSync(finalPath) || fs.statSync(finalPath).size === 0) {
    throw new Error(result.stderr || "Could not extract a segment from the full source video.");
  }

  return {
    rawPath: input.sourcePath,
    finalPath,
    endMs: input.startMs + SEGMENT_MS,
  };
}

export async function captureAudioSegmentFromSourceFile(input: {
  sourcePath: string;
  outputDir: string;
  segmentIndex: number;
  startMs: number;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const finalPath = path.join(input.outputDir, `segment-${String(input.segmentIndex).padStart(5, "0")}.m4a`);
  fs.rmSync(finalPath, { force: true });
  const result = await runCommand("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-xerror",
    "-ss",
    toSectionTimestamp(input.startMs),
    "-i",
    input.sourcePath,
    "-t",
    toSectionTimestamp(SEGMENT_MS),
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    finalPath,
  ], process.cwd(), {
    timeoutMs: 4 * 60_000,
    signal: input.signal,
  });

  if (result.exitCode !== 0 || !(await canDecodeAudio(finalPath))) {
    fs.rmSync(finalPath, { force: true });
    throw new Error(result.stderr || "Could not extract an audio segment from the source audio.");
  }

  return {
    rawPath: input.sourcePath,
    finalPath,
    endMs: input.startMs + SEGMENT_MS,
  };
}
