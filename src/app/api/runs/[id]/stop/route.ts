import { bootstrapServer } from "@/lib/server/bootstrap";
import { cancelRunActivity } from "@/lib/server/runtime";
import { getRun, stopRun } from "@/lib/server/repository";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const run = getRun(id);

  if (!run) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  const stopped = stopRun(id);
  cancelRunActivity(id);
  return Response.json({ run: stopped });
}
