import fs from "node:fs";
import path from "node:path";
import { safeJsonParse } from "@/lib/utils";
import { ensureRunDirectories } from "./fs";
import { runYtDlpWithFallbacks } from "./ytdlp";

type YtdlpMetadata = {
  duration?: number | null;
  is_live?: boolean | null;
  live_status?: string | null;
  title?: string | null;
  fulltitle?: string | null;
  requested_downloads?: Array<{
    url?: string | null;
    manifest_url?: string | null;
    format_id?: string | null;
    protocol?: string | null;
    vcodec?: string | null;
    acodec?: string | null;
    http_headers?: Record<string, string> | null;
  }> | null;
  formats?: Array<{
    url?: string | null;
    manifest_url?: string | null;
    format_id?: string | null;
    protocol?: string | null;
    vcodec?: string | null;
    acodec?: string | null;
    height?: number | null;
    http_headers?: Record<string, string> | null;
  }> | null;
};

export type SourceMetadata = {
  durationMs: number | null;
  isLive: boolean | null;
  sourceMode: "vod" | "live" | "upcoming" | "unknown";
  liveStatus: string | null;
  title: string | null;
  fetchedAtMs: number;
  liveCapture: {
    playlistUrl: string;
    formatId: string | null;
    headers: Record<string, string>;
  } | null;
};

function getMetadataPath(runId: string) {
  return path.join(ensureRunDirectories(runId).root, "source-metadata.json");
}

export function readSourceMetadata(runId: string): SourceMetadata | null {
  const metadataPath = getMetadataPath(runId);
  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  return safeJsonParse<SourceMetadata | null>(fs.readFileSync(metadataPath, "utf8"), null);
}

export async function ensureSourceMetadata(input: { runId: string; url: string; forceRefresh?: boolean }) {
  const existing = readSourceMetadata(input.runId);
  if (existing && !input.forceRefresh) {
    return existing;
  }

  let result;
  try {
    ({ result } = await runYtDlpWithFallbacks({
      url: input.url,
      args: [
        "--dump-single-json",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
      ],
      timeoutMs: 30_000,
    }));
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Could not inspect source metadata: ${error.message}`
        : "Could not inspect source metadata.",
    );
  }

  const payload = safeJsonParse<YtdlpMetadata | null>(result.stdout, null);
  if (!payload) {
    const details = (result.stderr || result.stdout || "").trim();
    throw new Error(
      details
        ? `yt-dlp returned no parseable source metadata: ${details}`
        : "yt-dlp returned no source metadata.",
    );
  }

  const requestedLiveDownload = payload.requested_downloads?.find((download) =>
    typeof download.url === "string" &&
    download.protocol?.includes("m3u8") &&
    download.vcodec &&
    download.vcodec !== "none" &&
    download.acodec &&
    download.acodec !== "none"
  ) ?? null;

  const fallbackLiveFormat = payload.formats
    ?.filter((format) =>
      typeof format.url === "string" &&
      format.protocol?.includes("m3u8") &&
      format.vcodec &&
      format.vcodec !== "none" &&
      format.acodec &&
      format.acodec !== "none"
    )
    .sort((left, right) => (right.height ?? 0) - (left.height ?? 0))[0] ?? null;

  const liveFormat = requestedLiveDownload ?? fallbackLiveFormat;
  const liveStatus = payload.live_status ?? null;
  const isLive = payload.is_live === true
    ? true
    : liveStatus === "is_live"
      ? true
      : liveStatus === "is_upcoming"
        ? null
        : typeof payload.is_live === "boolean"
          ? payload.is_live
          : liveStatus
            ? false
            : null;

  const sourceMode =
    isLive === false
      ? "vod"
      : isLive === true
        ? "live"
        : liveStatus === "is_upcoming"
          ? "upcoming"
          : "unknown";

  const metadata: SourceMetadata = {
    durationMs: typeof payload.duration === "number" ? Math.round(payload.duration * 1000) : null,
    isLive,
    sourceMode,
    liveStatus,
    title: payload.fulltitle ?? payload.title ?? null,
    fetchedAtMs: Date.now(),
    liveCapture: isLive === true && liveFormat?.url
      ? {
          playlistUrl: liveFormat.url,
          formatId: liveFormat.format_id ?? null,
          headers: liveFormat.http_headers ?? {},
        }
      : null,
  };

  fs.writeFileSync(getMetadataPath(input.runId), JSON.stringify(metadata, null, 2));
  return metadata;
}
