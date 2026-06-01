import { z } from "zod";
import { bootstrapServer } from "@/lib/server/bootstrap";
import { parseJsonBody } from "@/lib/server/http";
import { createRun, listRuns } from "@/lib/server/repository";
import { detectPlatform, normalizeSourceUrl } from "@/lib/utils";

const createRunSchema = z.object({
  url: z.string().url(),
  label: z.string().trim().min(1).max(80).optional(),
});

export async function GET() {
  bootstrapServer();
  return Response.json({ runs: listRuns() });
}

export async function POST(request: Request) {
  bootstrapServer();
  const { data: payload, error } = await parseJsonBody(request, createRunSchema);

  if (error) {
    return error;
  }

  const sourceUrl = normalizeSourceUrl(payload.url);
  const parsedUrl = new URL(sourceUrl);
  const platform = detectPlatform(sourceUrl);
  const hostname = parsedUrl.hostname.toLowerCase();

  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") {
    return Response.json(
      { error: "Please use a real YouTube or X source URL, not a local app URL." },
      { status: 400 },
    );
  }

  if (platform === "unknown") {
    return Response.json(
      { error: "This tool currently supports YouTube and X source URLs." },
      { status: 400 },
    );
  }

  const detail = createRun({ ...payload, url: sourceUrl });
  return Response.json({ run: detail }, { status: 201 });
}
