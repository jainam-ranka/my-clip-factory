import Link from "next/link";
import { NewRunForm } from "@/components/new-run-form";
import { bootstrapDataStore } from "@/lib/server/bootstrap";
import { getRunSummary, listRuns } from "@/lib/server/repository";
import { formatDuration } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function HomePage() {
  bootstrapDataStore();
  const runs = listRuns();
  const activeRuns = runs.filter((run) => run.status === "active").length;
  const queuedRenders = runs.filter((run) => run.status === "active" || run.status === "pending").length;
  const latestRuns = runs.slice(0, 4).map((run) => {
    const summary = getRunSummary(run.id);

    return {
      run,
      pendingClips: summary.pendingClips,
      renderedClips: summary.renderedClips,
      capturedMs:
        run.status === "active"
          ? (summary.capturedMediaMs || run.captureCursorMs)
          : (summary.capturedTranscriptMs || summary.capturedMediaMs || run.captureCursorMs),
    };
  });

  return (
    <div className="shell">
      <section className="hero">
        <div className="eyebrow-row">
          <span className="eyebrow">Overview</span>
          <Link className="eyebrow-link" href="/runs">
            Runs
          </Link>
          <Link className="eyebrow-link" href="/templates">
            Templates
          </Link>
        </div>
        <div className="hero-grid">
          <div>
            <h1 className="hero-title">Monitor the source, catch the moment, ship the clip.</h1>
            <p className="hero-copy">
              Run local-first capture and review for live or recorded video sources, surface high-signal
              moments, and turn approved clips into export-ready exports without leaving the studio.
            </p>
            <div className="hero-metrics">
              <div className="metric">
                <strong>{activeRuns}</strong>
                <span className="muted">Active runs</span>
              </div>
              <div className="metric">
                <strong>{queuedRenders}</strong>
                <span className="muted">Queued exports</span>
              </div>
              <div className="metric">
                <strong>{runs.filter((run) => run.status === "ready" || run.status === "stopped").length}</strong>
                <span className="muted">Completed runs</span>
              </div>
            </div>
          </div>

          <div className="stack hero-form-panel">
            <div>
              <div className="panel-title">
                <h2>Start Run</h2>
                <span className="pill mono pill-muted">Local-first</span>
              </div>
              <NewRunForm />
            </div>
          </div>
        </div>
      </section>

      <section className="panel section-panel">
        <div className="panel-title">
          <h2>Recent Runs</h2>
          <div className="badge-row">
            <Link className="pill mono" href="/templates">
              Templates
            </Link>
            <Link className="pill mono" href="/runs">
              View all
            </Link>
          </div>
        </div>
        <div className="run-grid">
          {latestRuns.map(({ run, pendingClips, renderedClips, capturedMs }) => (
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
                      <span>{pendingClips} pending clips</span>
                      <span>{renderedClips} rendered clips</span>
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
                  <span>Platform</span>
                  <strong>{run.platform}</strong>
                </div>
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
                  <span>Error</span>
                  <strong>{run.errorMessage ? "Attention needed" : "Healthy"}</strong>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
