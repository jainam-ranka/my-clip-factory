import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { RUNTIME_ASSETS_DIR } from "@/lib/config";
import { ensureDir } from "@/lib/server/fs";
import { runCommand } from "@/lib/server/process";
import { createId, slugify } from "@/lib/utils";

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const ALLOWED_PREFIXES = ["video/", "audio/", "image/"];

function createAssetHash(bytes: Uint8Array, mimeType: string) {
  return crypto.createHash("sha1").update(bytes).update(mimeType).digest("hex").slice(0, 12);
}

async function normalizeAsset(inputPath: string, mimeType: string, safeBaseName: string, assetHash: string) {
  if (mimeType.startsWith("image/")) {
    const outputPath = path.join(RUNTIME_ASSETS_DIR, `${safeBaseName}-${assetHash}.png`);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return outputPath;
    }

    const result = await runCommand("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      outputPath,
    ], process.cwd(), { timeoutMs: 2 * 60_000 });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Could not prepare the uploaded image.");
    }

    return outputPath;
  }

  if (mimeType.startsWith("video/")) {
    const outputPath = path.join(RUNTIME_ASSETS_DIR, `${safeBaseName}-${assetHash}.mp4`);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return outputPath;
    }

    const result = await runCommand("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      outputPath,
    ], process.cwd(), { timeoutMs: 20 * 60_000 });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Could not prepare the uploaded video.");
    }

    return outputPath;
  }

  const outputPath = path.join(RUNTIME_ASSETS_DIR, `${safeBaseName}-${assetHash}.m4a`);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    return outputPath;
  }

  const result = await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    outputPath,
  ], process.cwd(), { timeoutMs: 10 * 60_000 });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "Could not prepare the uploaded audio.");
  }

  return outputPath;
}

export async function POST(request: Request) {
  bootstrapServer();
  ensureDir(RUNTIME_ASSETS_DIR);

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return Response.json({ error: "No file was uploaded." }, { status: 400 });
  }

  if (!ALLOWED_PREFIXES.some((prefix) => file.type.startsWith(prefix))) {
    return Response.json({ error: "Only local audio, video, and image files can be uploaded here." }, { status: 400 });
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "That file is too large. Keep uploads under 250MB." }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  const fileBuffer = Buffer.from(bytes);
  const extension = path.extname(file.name) || "";
  const safeBaseName = slugify(path.basename(file.name, extension)) || "asset";
  const assetHash = createAssetHash(fileBuffer, file.type);
  const tempInputPath = path.join(RUNTIME_ASSETS_DIR, `${safeBaseName}-${createId("upload")}${extension.toLowerCase()}`);
  fs.writeFileSync(tempInputPath, fileBuffer);

  let outputPath = tempInputPath;
  try {
    outputPath = await normalizeAsset(tempInputPath, file.type, safeBaseName, assetHash);
  } finally {
    if (fs.existsSync(tempInputPath)) {
      fs.unlinkSync(tempInputPath);
    }
  }

  return Response.json({
    asset: {
      label: file.name,
      publicSrc: `/runtime/assets/${path.basename(outputPath)}`,
    },
  });
}
