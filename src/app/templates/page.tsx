import Link from "next/link";
import { TemplatesClient } from "@/components/templates-client";
import { bootstrapDataStore } from "@/lib/server/bootstrap";
import { listRenderTemplates } from "@/lib/server/repository";

export const dynamic = "force-dynamic";

export default function TemplatesPage() {
  bootstrapDataStore();
  const templates = listRenderTemplates();

  return (
    <div className="shell">
      <div className="page-header">
        <div>
          <div className="eyebrow-row">
            <Link className="eyebrow-link" href="/">
              Overview
            </Link>
            <Link className="eyebrow-link" href="/runs">
              Runs
            </Link>
            <span className="eyebrow">Templates</span>
          </div>
          <h1 className="page-title">Templates</h1>
          <p className="hero-copy">
            Define reusable export looks once, then apply them consistently during clip approval.
          </p>
        </div>
      </div>
      <TemplatesClient initialTemplates={templates} />
    </div>
  );
}
