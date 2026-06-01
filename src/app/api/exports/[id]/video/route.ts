import fs from "node:fs";
import path from "node:path";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { getRenderJob } from "@/lib/server/repository";

function readFileSlice(filePath: string, start: number, end: number) {
  const length = end - start + 1;
  const fileDescriptor = fs.openSync(filePath, "r");

  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fileDescriptor, buffer, 0, length, start);
    return buffer;
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const renderJob = getRenderJob(id);

  if (!renderJob?.outputPath) {
    return Response.json({ error: "Rendered video not found." }, { status: 404 });
  }

  if (!fs.existsSync(renderJob.outputPath)) {
    return Response.json({ error: "Rendered file is missing on disk." }, { status: 404 });
  }

  const stats = fs.statSync(renderJob.outputPath);
  const fileSize = stats.size;
  const rangeHeader = request.headers.get("range");

  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (!match) {
      return new Response("Invalid range request.", { status: 416 });
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : fileSize - 1;

    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start < 0 ||
      end < start ||
      start >= fileSize
    ) {
      return new Response("Requested range not satisfiable.", {
        status: 416,
        headers: {
          "Content-Range": `bytes */${fileSize}`,
        },
      });
    }

    const chunk = readFileSlice(renderJob.outputPath, start, end);

    return new Response(chunk, {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Disposition": `inline; filename="${path.basename(renderJob.outputPath)}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(fs.readFileSync(renderJob.outputPath), {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(fileSize),
      "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename="${path.basename(renderJob.outputPath)}"`,
      "Cache-Control": "no-store",
    },
  });
}
