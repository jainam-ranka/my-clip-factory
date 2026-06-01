import { bootstrapServer } from "@/lib/server/bootstrap";
import { getCandidate, setCandidateStatus } from "@/lib/server/repository";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  bootstrapServer();
  const { id } = await context.params;
  const candidate = getCandidate(id);

  if (!candidate) {
    return Response.json({ error: "Candidate not found." }, { status: 404 });
  }

  const rejected = setCandidateStatus(id, "rejected");
  return Response.json({ candidate: rejected });
}
