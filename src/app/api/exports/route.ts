import { bootstrapServer } from "@/lib/server/bootstrap";
import { listExports } from "@/lib/server/repository";

export async function GET() {
  bootstrapServer();
  return Response.json({ exports: listExports() });
}
