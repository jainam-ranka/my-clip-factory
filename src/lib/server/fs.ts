import fs from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  PUBLIC_RUNTIME_DIR,
  RUNTIME_ASSETS_DIR,
  RUNTIME_CLIPS_DIR,
  RUNTIME_EXPORTS_DIR,
  STORAGE_DIR,
} from "@/lib/config";

export function ensureBaseDirectories() {
  for (const dir of [DATA_DIR, STORAGE_DIR, PUBLIC_RUNTIME_DIR, RUNTIME_ASSETS_DIR, RUNTIME_CLIPS_DIR, RUNTIME_EXPORTS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensureRunDirectories(runId: string) {
  const root = path.join(STORAGE_DIR, runId);
  const segments = path.join(root, "segments");
  const transcripts = path.join(root, "transcripts");
  const clips = path.join(root, "clips");
  const temp = path.join(root, "temp");
  const source = path.join(root, "source");
  const approved = path.join(root, "approved");
  const liveAudio = path.join(root, "live-audio");
  const liveVideoCache = path.join(root, "live-video-cache");

  for (const dir of [root, segments, transcripts, clips, temp, source, approved, liveAudio, liveVideoCache]) {
    ensureDir(dir);
  }

  return { root, segments, transcripts, clips, temp, source, approved, liveAudio, liveVideoCache };
}

export function getRunSourceVideoPath(runId: string) {
  return path.join(ensureRunDirectories(runId).source, "source.mp4");
}

export function getRunSourceAudioPath(runId: string, extension = "m4a") {
  return path.join(ensureRunDirectories(runId).source, `source.${extension}`);
}

export function getApprovedCandidateDir(runId: string, candidateId: string) {
  const dir = path.join(ensureRunDirectories(runId).approved, candidateId);
  ensureDir(dir);
  return dir;
}
