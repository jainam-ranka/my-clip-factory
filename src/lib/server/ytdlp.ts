import {
  YT_DLP_COOKIES_FILE,
  YT_DLP_COOKIES_FROM_BROWSERS,
  YT_DLP_VISITOR_DATA,
} from "@/lib/config";
import { detectPlatform, normalizeSourceUrl } from "@/lib/utils";
import { runCommand, type CommandResult } from "./process";
import type { CaptureErrorCode } from "@/lib/types";

type YtDlpAuthAttempt = {
  label: string;
  args: string[];
};

function buildYoutubeAuthAttempts(): YtDlpAuthAttempt[] {
  const attempts: YtDlpAuthAttempt[] = [];

  if (YT_DLP_COOKIES_FILE) {
    attempts.push({
      label: "cookies-file",
      args: ["--cookies", YT_DLP_COOKIES_FILE],
    });
  }

  for (const browser of YT_DLP_COOKIES_FROM_BROWSERS) {
    attempts.push({
      label: `cookies-from-${browser}`,
      args: ["--cookies-from-browser", browser],
    });
  }

  attempts.push({
    label: "no-auth",
    args: [],
  });

  return attempts;
}

function buildExtractorArgs(url: string) {
  if (detectPlatform(url) !== "youtube" || !YT_DLP_VISITOR_DATA) {
    return [];
  }

  return ["--extractor-args", `youtube:visitor_data=${YT_DLP_VISITOR_DATA}`];
}

export async function runYtDlpWithFallbacks(input: {
  url: string;
  args: string[];
  timeoutMs: number;
  cwd?: string;
  signal?: AbortSignal;
}) {
  const url = normalizeSourceUrl(input.url);
  const platform = detectPlatform(url);
  const authAttempts = platform === "youtube"
    ? buildYoutubeAuthAttempts()
    : [{ label: "default", args: [] }];
  const extractorArgs = buildExtractorArgs(input.url);
  const errors: string[] = [];
  let lastResult: CommandResult | null = null;

  for (const attempt of authAttempts) {
    const result = await runCommand(
      "yt-dlp",
      [...attempt.args, ...extractorArgs, ...input.args, url],
      input.cwd ?? process.cwd(),
      { timeoutMs: input.timeoutMs, signal: input.signal },
    );

    lastResult = result;

    if (result.exitCode === 0) {
      return {
        result,
        authLabel: attempt.label,
      };
    }

    const cleanedMessage = (result.stderr || result.stdout || "Unknown yt-dlp error.")
      .replace(/\s+$/g, "")
      .trim();
    errors.push(`[${attempt.label}] ${cleanedMessage}`);
  }

  throw new Error(
    errors.join("\n\n----\n\n") ||
      lastResult?.stderr ||
      lastResult?.stdout ||
      "yt-dlp failed.",
  );
}

export function classifyYtDlpError(message: string): Exclude<CaptureErrorCode, null> {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("sign in to confirm") ||
    normalized.includes("not a bot") ||
    normalized.includes("visitor data") ||
    normalized.includes("cookies")
  ) {
    return "needs_auth";
  }
  if (normalized.includes("http error 429") || normalized.includes("too many requests") || normalized.includes("rate limit")) {
    return "rate_limited";
  }
  if (normalized.includes("not currently live") || normalized.includes("premieres in") || normalized.includes("is_upcoming")) {
    return "stream_not_started";
  }
  if (normalized.includes("post_live") || normalized.includes("ended") || normalized.includes("no longer live")) {
    return "stream_ended";
  }
  if (normalized.includes("unsupported url") || normalized.includes("unsupported source")) {
    return "unsupported_source";
  }
  return "temporary_capture_error";
}
