"use client";

import type { FormEvent } from "react";
import { startTransition, useEffect, useMemo, useState } from "react";
import type { RenderJob, RenderTemplate, RunDetail } from "@/lib/types";
import { formatDuration } from "@/lib/format";

type DashboardPayload = {
  runs: RunDetail[];
  exports: Array<RenderJob & { title: string; hook: string; fileName: string | null }>;
};

type FormState = {
  url: string;
  label: string;
};

type ManualRenderState = {
  start: string;
  end: string;
  title: string;
  hook: string;
};

function parseTimestampInput(value: string) {
  const parts = value.trim().split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part) || part < 0)) {
    return null;
  }

  if (parts.length === 3) {
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  }

  if (parts.length === 2) {
    return (parts[0] * 60 + parts[1]) * 1000;
  }

  if (parts.length === 1 && parts[0] >= 0) {
    return parts[0] * 1000;
  }

  return null;
}

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? "Request failed.");
  }

  return (await response.json()) as T;
}

export function DashboardClient({
  initialRuns,
  initialExports,
}: {
  initialRuns: RunDetail[];
  initialExports: DashboardPayload["exports"];
}) {
  const [form, setForm] = useState<FormState>({ url: "", label: "" });
  const [runs, setRuns] = useState(initialRuns);
  const [exportsFeed, setExportsFeed] = useState(initialExports);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initialRuns.map((run) => [run.run.id, true])),
  );
  const [manualRenderByRun, setManualRenderByRun] = useState<Record<string, ManualRenderState>>({});

  async function refresh() {
    const runSummaries = await fetchJson<{ runs: Array<{ id: string }> }>("/api/runs");
    const detailedRuns = await Promise.all(
      runSummaries.runs.map(async (run) => {
        const detail = await fetchJson<{ run: RunDetail }>(`/api/runs/${run.id}`);
        return detail.run;
      }),
    );
    const exportsPayload = await fetchJson<{ exports: DashboardPayload["exports"] }>("/api/exports");

    startTransition(() => {
      setRuns(detailedRuns);
      setExportsFeed(exportsPayload.exports);
      setExpandedRuns((current) => {
        const next = { ...current };
        for (const run of detailedRuns) {
          if (!(run.run.id in next)) {
            next[run.run.id] = true;
          }
        }
        return next;
      });
    });
  }

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh().catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : "Failed to refresh dashboard.");
      });
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const stats = useMemo(() => {
    const candidates = runs.flatMap((run) => run.candidates);
    return {
      activeRuns: runs.filter((run) => run.run.status === "active").length,
      pendingReview: candidates.filter((candidate) => candidate.status === "pending").length,
      exported: exportsFeed.length,
    };
  }, [exportsFeed.length, runs]);

  async function createRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await fetchJson("/api/runs", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setForm({ url: "", label: "" });
      await refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not create run.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function approveCandidate(candidateId: string) {
    const templatesPayload = await fetchJson<{ templates: RenderTemplate[] }>("/api/templates");
    const template = templatesPayload.templates[0];

    if (!template) {
      setErrorMessage("Create a template before approving clips.");
      return;
    }

    await fetchJson(`/api/candidates/${candidateId}/approve`, {
      method: "POST",
      body: JSON.stringify({ templateId: template.id }),
    });
    await refresh();
  }

  async function rejectCandidate(candidateId: string) {
    await fetchJson(`/api/candidates/${candidateId}/reject`, { method: "POST" });
    await refresh();
  }

  async function stopRun(runId: string) {
    await fetchJson(`/api/runs/${runId}/stop`, { method: "POST" });
    await refresh();
  }

  async function submitManualRender(runId: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formState = manualRenderByRun[runId] ?? { start: "", end: "", title: "", hook: "" };
    const startMs = parseTimestampInput(formState.start);
    const endMs = parseTimestampInput(formState.end);

    if (startMs === null || endMs === null) {
      setErrorMessage("Use timestamps like 00:01:30 or 90.");
      return;
    }

    if (endMs <= startMs) {
      setErrorMessage("End timestamp must be after start timestamp.");
      return;
    }

    setErrorMessage(null);
    await fetchJson(`/api/runs/${runId}/manual-render`, {
      method: "POST",
      body: JSON.stringify({
        startMs,
        endMs,
        title: formState.title || undefined,
        hook: formState.hook || undefined,
      }),
    });
    setManualRenderByRun((current) => ({
      ...current,
      [runId]: { start: "", end: "", title: "", hook: "" },
    }));
    await refresh();
  }

  return (
    <div className="shell">
      <section className="hero">
        <span className="eyebrow">Live Clip Factory</span>
        <div className="hero-grid">
          <div>
            <h1 className="hero-title">Catch the moment before the stream moves on.</h1>
            <p className="hero-copy">
              Paste a live YouTube or X stream, keep a rolling transcript, let ChatGPT flag highlight
              windows every 30 seconds, and approve dual-format exports with dynamic word-by-word
              subtitles plus your outro.
            </p>
            <div className="hero-metrics">
              <div className="metric">
                <strong>{stats.activeRuns}</strong>
                <span className="muted">Active live runs</span>
              </div>
              <div className="metric">
                <strong>{stats.pendingReview}</strong>
                <span className="muted">Moments waiting on you</span>
              </div>
              <div className="metric">
                <strong>{stats.exported}</strong>
                <span className="muted">Rendered clip exports</span>
              </div>
            </div>
          </div>

          <div className="stack">
            <div>
              <div className="panel-title">
                <h2>Start a live source</h2>
                <span className="pill mono">60s chunks</span>
              </div>
              <form className="url-form" onSubmit={createRun}>
                <div>
                  <label className="field-label" htmlFor="source-url">
                    Livestream URL
                  </label>
                  <input
                    id="source-url"
                    className="text-input"
                    placeholder="https://youtube.com/live/... or https://x.com/i/broadcasts/..."
                    value={form.url}
                    onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))}
                    required
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="source-label">
                    Run Label
                  </label>
                  <input
                    id="source-label"
                    className="text-input"
                    placeholder="Morning spaces, keynote, interview..."
                    value={form.label}
                    onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
                  />
                </div>
                <div className="button-row">
                  <button className="button button-primary" type="submit" disabled={isSubmitting}>
                    {isSubmitting ? "Starting..." : "Start Live Pipeline"}
                  </button>
                  <button className="button button-secondary" type="button" onClick={() => void refresh()}>
                    Refresh
                  </button>
                </div>
              </form>
            </div>

            <div className="callout">
              Local transcription is the default path. If `faster-whisper` is missing, the app will try
              `whisper.cpp`; if neither is available, the run will pause with a clear error message in the
              dashboard.
            </div>
          </div>
        </div>
      </section>

      {errorMessage ? (
        <p className="footer-note" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <div className="content-grid">
        <div className="stack">
          <section className="panel">
            <div className="panel-title">
              <h2>Runs and transcript windows</h2>
              <span className="pill mono">{runs.length} total</span>
            </div>

            <div className="run-list">
              {runs.length === 0 ? (
                <div className="empty">No live runs yet. Start one to begin capturing transcript windows.</div>
              ) : null}

              {runs.map((detail) => (
                <article className="run-card" key={detail.run.id}>
                  <div className="run-card-header">
                    <div>
                      <button
                        className="run-title-button"
                        type="button"
                        onClick={() =>
                          setExpandedRuns((current) => ({
                            ...current,
                            [detail.run.id]: !current[detail.run.id],
                          }))
                        }
                      >
                        <h3>{detail.run.label}</h3>
                      </button>
                      <p className="run-url mono">
                        <a href={detail.run.sourceUrl} target="_blank" rel="noreferrer">
                          {detail.run.sourceUrl}
                        </a>
                      </p>
                    </div>
                    <div className="run-toggle-right">
                      <span className={`pill status-${detail.run.status}`}>{detail.run.status}</span>
                      <span className="pill mono">{expandedRuns[detail.run.id] ? "Open" : "Closed"}</span>
                    </div>
                  </div>

                  <div className="meta-grid">
                    <div>
                      <span>Platform</span>
                      <strong>{detail.run.platform}</strong>
                    </div>
                    <div>
                      <span>Captured</span>
                      <strong>{formatDuration(detail.run.captureCursorMs)}</strong>
                    </div>
                    <div>
                      <span>Last Segment</span>
                      <strong className="mono">
                        {detail.run.lastSegmentAt ? new Date(detail.run.lastSegmentAt).toLocaleTimeString() : "—"}
                      </strong>
                    </div>
                    <div>
                      <span>Last Analysis</span>
                      <strong className="mono">
                        {detail.run.lastAnalysisAt ? new Date(detail.run.lastAnalysisAt).toLocaleTimeString() : "—"}
                      </strong>
                    </div>
                  </div>

                  {detail.run.errorMessage ? (
                    <p className="callout" style={{ marginTop: 16 }}>
                      {detail.run.errorMessage}
                    </p>
                  ) : null}

                  {expandedRuns[detail.run.id] ? (
                    <div className="run-details">
                      <div className="panel run-controls">
                        <div className="panel-title">
                          <h3>Livestream actions</h3>
                          <span className="pill mono">from start / earliest possible</span>
                        </div>
                        <div className="button-row">
                          <button
                            className="button button-danger"
                            type="button"
                            disabled={detail.run.status !== "active"}
                            onClick={() => void stopRun(detail.run.id)}
                          >
                            Stop clipping
                          </button>
                        </div>
                        <form
                          className="url-form"
                          style={{ marginTop: 18 }}
                          onSubmit={(event) => void submitManualRender(detail.run.id, event)}
                        >
                          <div className="panel-title">
                            <h3>Render timestamps</h3>
                            <span className="pill mono">HH:MM:SS</span>
                          </div>
                          <div className="grid-2">
                            <div>
                              <label className="field-label" htmlFor={`manual-start-${detail.run.id}`}>
                                Start
                              </label>
                              <input
                                id={`manual-start-${detail.run.id}`}
                                className="text-input"
                                placeholder="00:01:30"
                                value={manualRenderByRun[detail.run.id]?.start ?? ""}
                                onChange={(event) =>
                                  setManualRenderByRun((current) => ({
                                    ...current,
                                    [detail.run.id]: {
                                      start: event.target.value,
                                      end: current[detail.run.id]?.end ?? "",
                                      title: current[detail.run.id]?.title ?? "",
                                      hook: current[detail.run.id]?.hook ?? "",
                                    },
                                  }))
                                }
                              />
                            </div>
                            <div>
                              <label className="field-label" htmlFor={`manual-end-${detail.run.id}`}>
                                End
                              </label>
                              <input
                                id={`manual-end-${detail.run.id}`}
                                className="text-input"
                                placeholder="00:02:10"
                                value={manualRenderByRun[detail.run.id]?.end ?? ""}
                                onChange={(event) =>
                                  setManualRenderByRun((current) => ({
                                    ...current,
                                    [detail.run.id]: {
                                      start: current[detail.run.id]?.start ?? "",
                                      end: event.target.value,
                                      title: current[detail.run.id]?.title ?? "",
                                      hook: current[detail.run.id]?.hook ?? "",
                                    },
                                  }))
                                }
                              />
                            </div>
                          </div>
                          <div className="grid-2">
                            <div>
                              <label className="field-label" htmlFor={`manual-title-${detail.run.id}`}>
                                Clip title
                              </label>
                              <input
                                id={`manual-title-${detail.run.id}`}
                                className="text-input"
                                placeholder="My manual highlight"
                                value={manualRenderByRun[detail.run.id]?.title ?? ""}
                                onChange={(event) =>
                                  setManualRenderByRun((current) => ({
                                    ...current,
                                    [detail.run.id]: {
                                      start: current[detail.run.id]?.start ?? "",
                                      end: current[detail.run.id]?.end ?? "",
                                      title: event.target.value,
                                      hook: current[detail.run.id]?.hook ?? "",
                                    },
                                  }))
                                }
                              />
                            </div>
                            <div>
                              <label className="field-label" htmlFor={`manual-hook-${detail.run.id}`}>
                                Hook
                              </label>
                              <input
                                id={`manual-hook-${detail.run.id}`}
                                className="text-input"
                                placeholder="Optional subtitle for the clip"
                                value={manualRenderByRun[detail.run.id]?.hook ?? ""}
                                onChange={(event) =>
                                  setManualRenderByRun((current) => ({
                                    ...current,
                                    [detail.run.id]: {
                                      start: current[detail.run.id]?.start ?? "",
                                      end: current[detail.run.id]?.end ?? "",
                                      title: current[detail.run.id]?.title ?? "",
                                      hook: event.target.value,
                                    },
                                  }))
                                }
                              />
                            </div>
                          </div>
                          <div className="button-row">
                            <button className="button button-primary" type="submit">
                              Approve timestamps + render
                            </button>
                          </div>
                        </form>
                      </div>

                      <div className="grid-2" style={{ marginTop: 18 }}>
                        <div className="flat-subsection">
                          <div className="panel-title">
                            <h3>Rolling transcript</h3>
                            <span className="pill mono">
                              {formatDuration(detail.transcript.startedAtMs)} - {formatDuration(detail.transcript.endedAtMs)}
                            </span>
                          </div>
                          <div className="token-list">
                            {detail.transcript.tokens.length === 0 ? (
                              <div className="empty">Transcript tokens will appear here as segments finish processing.</div>
                            ) : null}
                            {detail.transcript.tokens.map((token) => (
                              <div className="token" key={token.id}>
                                <div className="token-text">{token.text}</div>
                                <div className="mono muted">
                                  {formatDuration(token.startMs)} - {formatDuration(token.endMs)}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="flat-subsection">
                          <div className="panel-title">
                            <h3>Clip moments</h3>
                            <span className="pill mono">{detail.candidates.length} found</span>
                          </div>
                          <div className="candidate-list">
                            {detail.candidates.length === 0 ? (
                              <div className="empty">Approved, pending, and rejected clips will appear here.</div>
                            ) : null}
                            {detail.candidates.map((candidate) => (
                              <article className="candidate-card" key={candidate.id}>
                                <div className="candidate-card-header">
                                  <div>
                                    <h4>{candidate.title}</h4>
                                    <p className="run-url">{candidate.hook}</p>
                                  </div>
                                  <span className={`pill status-${candidate.status}`}>{candidate.status}</span>
                                </div>
                                <div className="badge-row">
                                  <span className="pill mono">
                                    {formatDuration(candidate.suggestedStartMs)} - {formatDuration(candidate.suggestedEndMs)}
                                  </span>
                                  <span className="pill mono">{Math.round(candidate.confidence * 100)}% confidence</span>
                                  {candidate.keywords.map((keyword) => (
                                    <span className="pill" key={keyword}>
                                      {keyword}
                                    </span>
                                  ))}
                                </div>
                                <p className="candidate-reason">{candidate.reason}</p>
                                {candidate.status === "pending" ? (
                                  <div className="button-row" style={{ marginTop: 14 }}>
                                    <button
                                      className="button button-primary"
                                      type="button"
                                      onClick={() => void approveCandidate(candidate.id)}
                                    >
                                      Approve + render 9:16 / 16:9
                                    </button>
                                    <button
                                      className="button button-danger"
                                      type="button"
                                      onClick={() => void rejectCandidate(candidate.id)}
                                    >
                                      Reject
                                    </button>
                                  </div>
                                ) : null}
                              </article>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-title">
              <h2>Export history</h2>
              <span className="pill mono">{exportsFeed.length} renders</span>
            </div>
            <div className="export-list">
              {exportsFeed.length === 0 ? (
                <div className="empty">Rendered clips will appear here once a clip is approved.</div>
              ) : null}
              {exportsFeed.map((item) => (
                <article className="export-card" key={item.id}>
                  <div className="export-card-header">
                    <div>
                      <h4>{item.title}</h4>
                      <p className="run-url">{item.hook}</p>
                      <p className="mono muted">{item.fileName ?? item.id}</p>
                    </div>
                    <span className={`pill status-${item.status}`}>{item.status}</span>
                  </div>
                  <div className="timeline-list">
                    <div className="timeline-row">
                      <span>Format</span>
                      <strong>{item.format}</strong>
                    </div>
                    <div className="timeline-row">
                      <span>File</span>
                      <strong className="mono">{item.fileName ?? "Pending output"}</strong>
                    </div>
                    <div className="timeline-row">
                      <span>Path</span>
                      <strong className="mono">{item.outputPath ?? "Rendering..."}</strong>
                    </div>
                    <div className="timeline-row">
                      <span>Drive</span>
                      {item.driveWebViewLink ? (
                        <a href={item.driveWebViewLink} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      ) : (
                        <strong>{item.driveUploadStatus.replace("_", " ")}</strong>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
