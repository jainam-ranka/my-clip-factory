import fs from "node:fs";
import path from "node:path";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { davinciSidecarPath } from "@/lib/server/davinci";
import { getRenderJob } from "@/lib/server/repository";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const render = getRenderJob(id);

  if (!render?.outputPath) {
    return Response.json({ error: "Export not found." }, { status: 404 });
  }

  const sidecarPath = davinciSidecarPath(render.outputPath);
  if (!fs.existsSync(sidecarPath)) {
    return Response.json({ error: "DaVinci timeline has not been generated for this export yet." }, { status: 404 });
  }

  const body = fs.readFileSync(sidecarPath);
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml",
      "Content-Disposition": `attachment; filename="${path.basename(sidecarPath)}"`,
    },
  });
}
