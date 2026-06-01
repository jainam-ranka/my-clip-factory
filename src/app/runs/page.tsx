import Link from "next/link";
import { NewRunForm } from "@/components/new-run-form";
import { bootstrapDataStore } from "@/lib/server/bootstrap";
import { getRunSummary, listRuns } from "@/lib/server/repository";
import { formatDuration } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function RunsPage() {
  bootstrapDataStore();
  const runs = listRuns().map((run) => {
    const summary = getRunSummary(run.id);
    return {
      run,
      capturedMs:
        run.status === "active"
          ? (summary.capturedMediaMs || run.captureCursorMs)
          : (summary.capturedTranscriptMs || summary.capturedMediaMs || run.captureCursorMs),
    };
  });

  return (
    <div className="shell">
      <div className="page-header">
        <div>
          <div className="eyebrow-row">
            <Link className="eyebrow-link" href="/">
              Overview
            </Link>
            <Link className="eyebrow-link" href="/templates">
              Templates
            </Link>
            <span className="eyebrow">All Runs</span>
          </div>
          <h1 className="page-title">Runs</h1>
          <p className="hero-copy">
            Review source health, transcript progress, clip moments, and export activity from one place.
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>All Runs</h2>
          <span className="pill mono">{runs.length} total</span>
        </div>
        <div className="run-grid">
          {runs.map(({ run, capturedMs }) => (
            <article className="run-card" key={run.id}>
              <div className="run-card-header">
                <div>
                  <h3>
                    <Link className="run-card-link" href={`/runs/${run.id}`}>
                      {run.label}
                    </Link>
                  </h3>
                  <div className="run-card-subline">
                    <div className="run-card-stats muted">
                      <span>{run.platform}</span>
                    </div>
                    <a
                      className="url-icon-button"
                      href={run.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open source URL"
                    >
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M8 6.5h5.5V12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M13.5 6.5 7.5 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        <path d="M12 10.5v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </a>
                  </div>
                </div>
                <span className={`pill status-${run.status}`}>{run.status}</span>
              </div>
              <div className="meta-grid">
                <div>
                  <span>Captured</span>
                  <strong>{formatDuration(capturedMs)}</strong>
                </div>
                <div>
                  <span>Last Segment</span>
                  <strong className="mono">
                    {run.lastSegmentAt ? new Date(run.lastSegmentAt).toLocaleTimeString() : "—"}
                  </strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong>{run.status}</strong>
                </div>
                <div>
                  <span>Error</span>
                  <strong>{run.errorMessage ? "Attention needed" : "Healthy"}</strong>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel section-panel">
        <div className="panel-title">
          <h2>Start Run</h2>
          <span className="pill mono pill-muted">Supported sources</span>
        </div>
        <NewRunForm />
      </section>
    </div>
  );
}
