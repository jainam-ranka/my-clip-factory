import { notFound } from "next/navigation";
import { RunDetailClient } from "@/components/run-detail-client";
import { bootstrapDataStore } from "@/lib/server/bootstrap";
import { getRunDetail, listExportsForRun, listRenderTemplates } from "@/lib/server/repository";

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  bootstrapDataStore();
  const { id } = await params;
  const detail = getRunDetail(id);

  if (!detail) {
    notFound();
  }

  const exportsFeed = listExportsForRun(id);
  const templates = listRenderTemplates();
  return <RunDetailClient initialRun={detail} initialExports={exportsFeed} initialTemplates={templates} />;
}
