import fs from "node:fs";
import path from "node:path";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { RUNTIME_ASSETS_DIR } from "@/lib/config";
import { isRuntimeAssetReferenced } from "@/lib/server/repository";

export async function POST(request: Request) {
  bootstrapServer();
  const payload = (await request.json().catch(() => null)) as { publicSrc?: string } | null;
  const publicSrc = payload?.publicSrc;

  if (!publicSrc?.startsWith("/runtime/assets/")) {
    return Response.json({ error: "Invalid asset path." }, { status: 400 });
  }

  const fileName = path.basename(publicSrc);
  if (isRuntimeAssetReferenced(publicSrc)) {
    return Response.json({ ok: true, referenced: true });
  }

  const resolvedPath = path.join(RUNTIME_ASSETS_DIR, fileName);
  if (fs.existsSync(resolvedPath)) {
    fs.rmSync(resolvedPath, { force: true });
  }

  return Response.json({ ok: true });
}
