import fs from "node:fs";
import path from "node:path";
import { createId } from "@/lib/utils";
import { PYTHON_BIN, TRANSCRIPTION_LANGUAGE, WHISPER_CPP_BIN, WHISPER_CPP_MODEL } from "@/lib/config";
import type { TranscriptToken } from "@/lib/types";
import { runCommand, throwIfAborted } from "./process";

type FasterWhisperWord = {
  word: string;
  start: number;
  end: number;
  probability?: number;
};

type FasterWhisperResponse = {
  words: FasterWhisperWord[];
};

type WhisperCppSegment = {
  text: string;
  offset_start: number;
  offset_end: number;
};

type WhisperCppResponse = {
  transcription?: Array<{
    text: string;
    offsets: {
      from: number;
      to: number;
    };
    tokens?: Array<{
      text: string;
      offsets?: {
        from: number;
        to: number;
      };
      p?: number;
    }>;
  }>;
};

type TimedWord = {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
};

const KNOWN_SPLIT_WORDS = new Set(["nasdaq", "solana"]);

function normalizeWord(text: string) {
  return text
    .replace(/[‘’‛`´]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\s*'\s*/g, "'")
    .trim();
}

function hasRenderableWordCharacter(text: string) {
  return /[A-Za-z0-9]/.test(text);
}

function isApostropheToken(text: string) {
  return /^'+$/.test(text);
}

function isLeadingApostropheFragment(text: string) {
  return /^'[A-Za-z0-9]+$/.test(text);
}

function isApostropheSuffix(text: string) {
  return /^(s|t|re|ve|ll|d|m|em|cause|n)$/i.test(text.replace(/^'+/, ""));
}

function mergeTimedWord(left: TimedWord, right: TimedWord, separator = ""): TimedWord {
  return {
    ...left,
    text: normalizeWord(`${left.text}${separator}${right.text}`),
    endMs: Math.max(left.endMs, right.endMs),
    confidence: left.confidence ?? right.confidence,
  };
}

function mergeApostropheFragments(words: TimedWord[]) {
  const merged: TimedWord[] = [];

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const previous = merged[merged.length - 1];
    const next = words[index + 1] ?? null;

    if (previous && isApostropheToken(word.text) && next && isApostropheSuffix(next.text)) {
      merged[merged.length - 1] = mergeTimedWord(previous, next, "'");
      index += 1;
      continue;
    }

    if (previous && isLeadingApostropheFragment(word.text) && isApostropheSuffix(word.text)) {
      merged[merged.length - 1] = mergeTimedWord(previous, word);
      continue;
    }

    if (previous && KNOWN_SPLIT_WORDS.has(`${previous.text}${word.text}`.toLowerCase())) {
      merged[merged.length - 1] = mergeTimedWord(previous, word);
      continue;
    }

    if (!hasRenderableWordCharacter(word.text)) {
      continue;
    }

    merged.push(word);
  }

  return merged;
}

function extractTranscriptTokens(input: {
  runId: string;
  segmentId: string;
  startOffsetMs: number;
  payload: FasterWhisperResponse;
}) {
  return mergeApostropheFragments(
    input.payload.words
      .map((word) => ({
        text: normalizeWord(word.word),
        startMs: input.startOffsetMs + Math.round(word.start * 1000),
        endMs: input.startOffsetMs + Math.round(word.end * 1000),
        confidence: typeof word.probability === "number" ? word.probability : null,
      }))
      .filter((word) => word.text.length > 0),
  )
    .map((word) => ({
      id: createId("token"),
      runId: input.runId,
      segmentId: input.segmentId,
      text: word.text,
      startMs: word.startMs,
      endMs: word.endMs,
      confidence: word.confidence,
      tokenKind: "word" as const,
      isFiller: false,
      isRemoved: false,
      editSource: "transcriber" as const,
    }))
    .filter((word) => hasRenderableWordCharacter(word.text));
}

function extractWhisperCppTokens(input: {
  runId: string;
  segmentId: string;
  startOffsetMs: number;
  payload: WhisperCppResponse;
}) {
  const tokens: TranscriptToken[] = [];

  for (const segment of input.payload.transcription ?? []) {
    const wordTokens = mergeApostropheFragments((segment.tokens ?? [])
      .map((token) => ({
        text: normalizeWord(token.text),
        startMs: input.startOffsetMs + (token.offsets?.from ?? segment.offsets.from),
        endMs: input.startOffsetMs + (token.offsets?.to ?? token.offsets?.from ?? segment.offsets.to),
        confidence: typeof token.p === "number" ? token.p : null,
      }))
      .filter((token) => token.text.length > 0 && !token.text.startsWith("[")));

    if (wordTokens.length > 0) {
      for (let index = 0; index < wordTokens.length; index += 1) {
        const word = wordTokens[index];
        const next = wordTokens[index + 1] ?? null;
        const endMs = word.endMs > word.startMs
          ? word.endMs
          : next
            ? Math.max(word.startMs + 1, next.startMs)
            : Math.max(word.startMs + 1, input.startOffsetMs + segment.offsets.to);
        tokens.push({
          id: createId("token"),
          runId: input.runId,
          segmentId: input.segmentId,
          text: word.text,
          startMs: word.startMs,
          endMs,
          confidence: word.confidence,
          tokenKind: "word",
          isFiller: false,
          isRemoved: false,
          editSource: "transcriber",
        });
      }
      continue;
    }

    const words = normalizeWord(segment.text).split(/\s+/).filter((word) => hasRenderableWordCharacter(word));
    if (words.length === 0) {
      continue;
    }
    const durationMs = Math.max(words.length, segment.offsets.to - segment.offsets.from);
    for (let index = 0; index < words.length; index += 1) {
      const startMs = input.startOffsetMs + segment.offsets.from + Math.round((durationMs * index) / words.length);
      const endMs = input.startOffsetMs + segment.offsets.from + Math.round((durationMs * (index + 1)) / words.length);
      tokens.push({
        id: createId("token"),
        runId: input.runId,
        segmentId: input.segmentId,
        text: words[index],
        startMs,
        endMs: Math.max(startMs + 1, endMs),
        confidence: null,
        tokenKind: "word",
        isFiller: false,
        isRemoved: false,
        editSource: "transcriber",
      });
    }
  }

  return tokens;
}

export async function transcribeSegment(input: {
  runId: string;
  segmentId: string;
  videoPath: string;
  startOffsetMs: number;
  outputDir: string;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const transcriptPath = path.join(input.outputDir, `${path.basename(input.videoPath, path.extname(input.videoPath))}.json`);
  const audioPath = path.join(input.outputDir, `${path.basename(input.videoPath, path.extname(input.videoPath))}.wav`);

  const audioExtract = await runCommand("ffmpeg", [
    "-y",
    "-i",
    input.videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    audioPath,
  ], process.cwd(), {
    timeoutMs: 60_000,
    signal: input.signal,
  });

  if (audioExtract.exitCode !== 0 || !fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
    throw new Error(audioExtract.stderr || "Could not extract audio for transcription.");
  }

  const fasterWhisper = await runCommand(PYTHON_BIN, [
    path.join(process.cwd(), "scripts", "transcribe_faster_whisper.py"),
    audioPath,
    transcriptPath,
    TRANSCRIPTION_LANGUAGE,
  ], process.cwd(), {
    timeoutMs: 20_000,
    signal: input.signal,
  });

  if (fasterWhisper.exitCode === 0 && !fasterWhisper.timedOut && fs.existsSync(transcriptPath)) {
    const payload = JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as FasterWhisperResponse;
    const tokens = extractTranscriptTokens({
      runId: input.runId,
      segmentId: input.segmentId,
      startOffsetMs: input.startOffsetMs,
      payload,
    });

    if (tokens.length > 0) {
      return { transcriptPath, tokens };
    }
  }

  const whisperCppOutput = path.join(input.outputDir, `${path.basename(input.videoPath, path.extname(input.videoPath))}-whispercpp.json`);
  const whisperCpp = await runCommand(WHISPER_CPP_BIN, [
    "-m",
    WHISPER_CPP_MODEL,
    "-f",
    audioPath,
    "-ojf",
    "-of",
    whisperCppOutput.replace(/\.json$/, ""),
    "-l",
    TRANSCRIPTION_LANGUAGE,
  ], process.cwd(), {
    timeoutMs: 120_000,
    signal: input.signal,
  });

  const fullWhisperPath = whisperCppOutput;

  if (whisperCpp.exitCode === 0 && fs.existsSync(fullWhisperPath)) {
    const payload = JSON.parse(fs.readFileSync(fullWhisperPath, "utf8")) as WhisperCppResponse;
    const tokens = extractWhisperCppTokens({
      runId: input.runId,
      segmentId: input.segmentId,
      startOffsetMs: input.startOffsetMs,
      payload,
    });
    return { transcriptPath: fullWhisperPath, tokens };
  }

  throw new Error(
    `No transcription engine available. faster-whisper stderr: ${fasterWhisper.stderr || "n/a"} whisper.cpp stderr: ${whisperCpp.stderr || "n/a"}`,
  );
}
