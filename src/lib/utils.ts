import crypto from "node:crypto";
import type { Platform } from "./types";
export { clamp, formatDuration, toSectionTimestamp } from "./format";

export function createId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export function detectPlatform(url: string): Platform {
  if (/youtube\.com|youtu\.be/i.test(url)) {
    return "youtube";
  }

  if (/x\.com|twitter\.com/i.test(url)) {
    return "x";
  }

  return "unknown";
}

export function normalizeSourceUrl(value: string) {
  const decoded = value
    .trim()
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&");

  try {
    const url = new URL(decoded);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");

    if (hostname === "youtube.com" || hostname === "m.youtube.com") {
      if (url.pathname === "/watch" && url.searchParams.has("v")) {
        const normalized = new URL("https://www.youtube.com/watch");
        normalized.searchParams.set("v", url.searchParams.get("v") ?? "");
        return normalized.toString();
      }
    }

    return url.toString();
  } catch {
    return decoded;
  }
}

export function toFfmpegTimestamp(ms: number) {
  const totalSeconds = ms / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = (totalSeconds % 60).toFixed(3).padStart(6, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

export function overlapMs(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

export function safeJsonParse<T>(input: string, fallback: T): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

export function createStableHash(value: string) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 10);
}

export function slugify(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "stream";
}
