"use client";

import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { FONT_OPTIONS } from "@/lib/fonts";
import type { RenderTemplate } from "@/lib/types";

type TemplateDraft = {
  name: string;
  mode: RenderTemplate["mode"];
  introSrc: string | null;
  introLabel: string;
  musicSrc: string | null;
  musicLabel: string;
  captionStyle: RenderTemplate["captionStyle"];
  captionSize: RenderTemplate["captionSize"];
  captionColor: string;
  captionPlacement: RenderTemplate["captionPlacement"];
  musicVolume: number;
  musicFadeIn: boolean;
  musicFadeOut: boolean;
  outroSrc: string | null;
  outroLabel: string;
  videoLayout: RenderTemplate["videoLayout"];
  videoFillMode: RenderTemplate["videoFillMode"];
  fontFamily: string;
  fontSource: RenderTemplate["fontSource"];
  subtitleMode: RenderTemplate["subtitleMode"];
};

function createEmptyDraft(): TemplateDraft {
  return {
    name: "",
    mode: "edited",
    introSrc: null,
    introLabel: "None selected",
    musicSrc: null,
    musicLabel: "None selected",
    captionStyle: "pill",
    captionSize: "md",
    captionColor: "#f4a60b",
    captionPlacement: "bottom",
    musicVolume: 12,
    musicFadeIn: true,
    musicFadeOut: true,
    outroSrc: null,
    outroLabel: "None selected",
    videoLayout: "landscape",
    videoFillMode: "blur",
    fontFamily: "Archivo",
    fontSource: "google",
    subtitleMode: "phrase_1_4",
  };
}

function assetLabel(publicSrc: string | null) {
  return publicSrc ? publicSrc.split("/").pop() ?? "Attached" : "None selected";
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

async function uploadAsset(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch("/api/assets/upload", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Could not upload ${file.name}.`);
  }

  return (await response.json()) as { asset: { label: string; publicSrc: string } };
}

function toDraft(template: RenderTemplate): TemplateDraft {
  return {
    name: template.name,
    mode: template.mode,
    introSrc: template.introSrc,
    introLabel: assetLabel(template.introSrc),
    musicSrc: template.musicSrc,
    musicLabel: assetLabel(template.musicSrc),
    captionStyle: template.captionStyle,
    captionSize: template.captionSize,
    captionColor: template.captionColor,
    captionPlacement: template.captionPlacement,
    musicVolume: template.musicVolume,
    musicFadeIn: template.musicFadeIn,
    musicFadeOut: template.musicFadeOut,
    outroSrc: template.outroSrc,
    outroLabel: assetLabel(template.outroSrc),
    videoLayout: template.videoLayout,
    videoFillMode: template.videoFillMode,
    fontFamily: template.fontFamily,
    fontSource: template.fontSource,
    subtitleMode: template.subtitleMode,
  };
}

function serializeDraft(draft: TemplateDraft) {
  return {
    name: draft.name,
    mode: draft.mode,
    aiMotionEnabled: draft.mode === "edited",
    motionIntensity: draft.mode === "raw" ? "none" : "subtle",
    allowPunchIns: draft.mode === "edited",
    maxMotionEvents: draft.mode === "raw" ? 0 : 4,
    enableCaptions: draft.mode === "edited",
    enableMotion: draft.mode === "edited",
    enableColor: draft.mode === "edited",
    enableMusic: draft.mode === "edited" && Boolean(draft.musicSrc),
    enableCompaction: draft.mode === "edited",
    colorGradePreset: "neutral",
    aiMusicEnabled: false,
    introSrc: draft.introSrc,
    musicSrc: draft.musicSrc,
    captionStyle: draft.captionStyle,
    captionSize: draft.captionSize,
    captionColor: draft.captionColor,
    captionPlacement: draft.captionPlacement,
    musicVolume: draft.musicVolume,
    musicFadeIn: draft.musicFadeIn,
    musicFadeOut: draft.musicFadeOut,
    outroSrc: draft.outroSrc,
    videoLayout: draft.videoLayout,
    videoFillMode: draft.videoFillMode,
    fontFamily: draft.fontFamily,
    fontSource: draft.fontSource,
    subtitleMode: draft.subtitleMode,
  };
}

export function TemplatesClient({ initialTemplates }: { initialTemplates: RenderTemplate[] }) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TemplateDraft>(createEmptyDraft());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const editingTemplate = useMemo(
    () => templates.find((template) => template.id === editingId) ?? null,
    [editingId, templates],
  );

  async function refreshTemplates() {
    const payload = await fetchJson<{ templates: RenderTemplate[] }>("/api/templates");
    setTemplates(payload.templates);
  }

  async function handleAssetFile(
    kind: "intro" | "outro" | "music",
    file: File | null,
  ) {
    if (!file) {
      setDraft((current) => {
        if (kind === "intro") {
          return { ...current, introSrc: null, introLabel: "None selected" };
        }

        if (kind === "music") {
          return { ...current, musicSrc: null, musicLabel: "None selected" };
        }

        return { ...current, outroSrc: null, outroLabel: "None selected" };
      });
      return;
    }

    setErrorMessage(null);
    const uploaded = await uploadAsset(file);
    setDraft((current) => {
      if (kind === "intro") {
        return {
          ...current,
          introSrc: uploaded.asset.publicSrc,
          introLabel: uploaded.asset.label,
        };
      }

      if (kind === "music") {
        return {
          ...current,
          musicSrc: uploaded.asset.publicSrc,
          musicLabel: uploaded.asset.label,
        };
      }

      return {
        ...current,
        outroSrc: uploaded.asset.publicSrc,
        outroLabel: uploaded.asset.label,
      };
    });
  }

  function resetForm() {
    setEditingId(null);
    setDraft(createEmptyDraft());
  }

  async function submitTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setErrorMessage(null);

    try {
      if (editingId) {
        await fetchJson(`/api/templates/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify(serializeDraft(draft)),
        });
      } else {
        await fetchJson("/api/templates", {
          method: "POST",
          body: JSON.stringify(serializeDraft(draft)),
        });
      }

      await refreshTemplates();
      resetForm();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not save the template.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteTemplate(templateId: string) {
    setErrorMessage(null);
    try {
      await fetchJson(`/api/templates/${templateId}`, {
        method: "DELETE",
      });
      await refreshTemplates();
      if (editingId === templateId) {
        resetForm();
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not delete the template.");
    }
  }

  return (
    <div className="workspace-stack">
      {errorMessage ? (
        <p className="footer-note" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <section className="panel section-panel">
        <div className="panel-title">
          <h2>{editingTemplate ? "Edit Template" : "Create Template"}</h2>
          <span className="pill mono">{templates.length} total</span>
        </div>
        <form className="flat-form" onSubmit={submitTemplate}>
          <div className="grid-3">
            <div>
              <label className="field-label" htmlFor="template-name">
                Template Name
              </label>
              <input
                id="template-name"
                className="text-input"
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Punchy social clip"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="template-mode">
                Mode
              </label>
              <select
                id="template-mode"
                className="select-input"
                value={draft.mode}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    mode: event.target.value as RenderTemplate["mode"],
                  }))
                }
              >
                <option value="edited">Edited</option>
                <option value="raw">Raw export</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="template-layout">
                Output Format
              </label>
              <select
                id="template-layout"
                className="select-input"
                value={draft.videoLayout}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    videoLayout: event.target.value as RenderTemplate["videoLayout"],
                  }))
                }
              >
                <option value="landscape">Horizontal</option>
                <option value="vertical">Vertical</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="template-fill-mode">
                Frame Fit
              </label>
              <select
                id="template-fill-mode"
                className="select-input"
                value={draft.videoFillMode}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    videoFillMode: event.target.value as RenderTemplate["videoFillMode"],
                  }))
                }
              >
                <option value="blur">Blur backdrop</option>
                <option value="contain">Clean contain</option>
                <option value="cover">Full bleed crop</option>
              </select>
            </div>
          </div>

          <div className="grid-2">
            <div>
              <label className="field-label" htmlFor="template-font">
                Font
              </label>
              <select
                id="template-font"
                className="select-input"
                value={`${draft.fontSource}:${draft.fontFamily}`}
                style={{ fontFamily: draft.fontFamily }}
                onChange={(event) => {
                  const [fontSource, fontFamily] = event.target.value.split(":");
                  setDraft((current) => ({
                    ...current,
                    fontFamily,
                    fontSource: fontSource as RenderTemplate["fontSource"],
                  }));
                }}
              >
                {FONT_OPTIONS.map((font) => (
                  <option
                    key={`${font.source}:${font.family}`}
                    value={`${font.source}:${font.family}`}
                    style={{ fontFamily: font.family }}
                  >
                    {font.family} · {font.source === "google" ? "Google" : "System"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid-3">
            <div>
              <label className="field-label" htmlFor="template-style">
                Caption Style
              </label>
              <select
                id="template-style"
                className="select-input"
                value={draft.captionStyle}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    captionStyle: event.target.value as RenderTemplate["captionStyle"],
                  }))
                }
              >
                <option value="pill">Pill</option>
                <option value="minimal">Minimal</option>
                <option value="mono">Mono</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="template-size">
                Caption Size
              </label>
              <select
                id="template-size"
                className="select-input"
                value={draft.captionSize}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    captionSize: event.target.value as RenderTemplate["captionSize"],
                  }))
                }
              >
                <option value="sm">Small</option>
                <option value="md">Medium</option>
                <option value="lg">Large</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="template-placement">
                Caption Placement
              </label>
              <select
                id="template-placement"
                className="select-input"
                value={draft.captionPlacement}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    captionPlacement: event.target.value as RenderTemplate["captionPlacement"],
                  }))
                }
              >
                <option value="top">Top</option>
                <option value="middle">Middle</option>
                <option value="bottom">Bottom</option>
              </select>
            </div>
          </div>

          <div className="grid-2">
            <div>
              <label className="field-label" htmlFor="template-color">
                Caption Color
              </label>
              <div className="color-input-shell">
                <input
                  id="template-color"
                  className="color-input"
                  type="color"
                  value={draft.captionColor}
                  onChange={(event) => setDraft((current) => ({ ...current, captionColor: event.target.value }))}
                />
                <span className="mono">{draft.captionColor.toUpperCase()}</span>
              </div>
            </div>
            <div className="flat-subsection">
              <div className="panel-title">
                <h3>Music</h3>
                <span className="pill mono">{draft.musicVolume}%</span>
              </div>
              <input
                className="range-input"
                type="range"
                min="0"
                max="100"
                value={draft.musicVolume}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    musicVolume: Number(event.target.value),
                  }))
                }
              />
              <div className="badge-row">
                <button
                  type="button"
                  className={`chip-toggle ${draft.musicFadeIn ? "chip-toggle-active" : ""}`}
                  onClick={() => setDraft((current) => ({ ...current, musicFadeIn: !current.musicFadeIn }))}
                >
                  Fade in
                </button>
                <button
                  type="button"
                  className={`chip-toggle ${draft.musicFadeOut ? "chip-toggle-active" : ""}`}
                  onClick={() => setDraft((current) => ({ ...current, musicFadeOut: !current.musicFadeOut }))}
                >
                  Fade out
                </button>
              </div>
            </div>
          </div>

          <div className="grid-2">
            <div>
              <label className="field-label" htmlFor="template-intro">
                Intro Asset
              </label>
              <input
                id="template-intro"
                className="file-input"
                type="file"
                accept="image/*,video/*"
                onChange={(event) => void handleAssetFile("intro", event.target.files?.[0] ?? null)}
              />
              <p className="field-hint">Current asset: {draft.introLabel}</p>
            </div>
            <div>
              <label className="field-label" htmlFor="template-outro">
                Outro Asset
              </label>
              <input
                id="template-outro"
                className="file-input"
                type="file"
                accept="video/*"
                onChange={(event) => void handleAssetFile("outro", event.target.files?.[0] ?? null)}
              />
              <p className="field-hint">Current asset: {draft.outroLabel}</p>
            </div>
            <div>
              <label className="field-label" htmlFor="template-music">
                Music Track
              </label>
              <input
                id="template-music"
                className="file-input"
                type="file"
                accept="audio/*"
                onChange={(event) => void handleAssetFile("music", event.target.files?.[0] ?? null)}
              />
              <p className="field-hint">Current asset: {draft.musicLabel}</p>
            </div>
          </div>

          <div className="flat-subsection approval-caption-preview">
            <span className="field-label">Preview</span>
            <div className={`template-preview-frame template-preview-fill-${draft.videoFillMode}`}>
              <div className="template-preview-media" />
              <div className="template-preview-overlay" />
              <div className="template-preview-hud">
                <span className="template-preview-pill">Clip</span>
                <strong>Big market shift in 90 seconds</strong>
                <span>Lead with the hook, keep the subject framed, and make captions readable.</span>
              </div>
              <div className={`template-preview-caption template-preview-caption-${draft.captionPlacement}`}>
                <div
                  className={`approval-caption-chip approval-caption-${draft.captionStyle} approval-caption-size-${draft.captionSize}`}
                  style={{ color: draft.captionColor }}
                >
                  Decisions compound fast
                </div>
              </div>
            </div>
            <div className="approval-asset-list">
              <div><strong>Format</strong><span>{draft.videoLayout}</span></div>
              <div><strong>Fit</strong><span>{draft.videoFillMode}</span></div>
              <div><strong>Intro</strong><span>{draft.introSrc ? "Attached" : "None"}</span></div>
              <div><strong>Music</strong><span>{draft.musicSrc ? "Attached" : "None"}</span></div>
              <div><strong>Outro</strong><span>{draft.outroSrc ? "Attached" : "None"}</span></div>
              <div><strong>Font</strong><span>{draft.fontFamily}</span></div>
            </div>
          </div>

          <div className="button-row">
            <button className="button button-primary" type="submit" disabled={isSaving}>
              {editingTemplate ? "Save template" : "Create template"}
            </button>
            {editingTemplate ? (
              <button className="button button-secondary" type="button" onClick={resetForm}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      </section>

      <section className="panel section-panel">
        <div className="panel-title">
          <h2>Saved Templates</h2>
          <span className="pill mono">{templates.length} templates</span>
        </div>
        <div className="run-grid">
          {templates.map((template) => (
            <article className="template-card" key={template.id}>
              <div className="template-card-header">
                <div>
                  <h3>{template.name}</h3>
                  <div className="run-card-stats muted">
                    <span>{template.mode}</span>
                    <span>{template.videoLayout}</span>
                    <span>{template.videoFillMode}</span>
                    <span>{template.fontFamily}</span>
                  </div>
                </div>
                <span className="pill mono pill-muted">{template.mode}</span>
              </div>
              <div className="template-preview">
                <div className={`template-preview-frame template-preview-fill-${template.videoFillMode}`}>
                  <div className="template-preview-media" />
                  <div className="template-preview-overlay" />
                  <div className="template-preview-hud">
                    <span className="template-preview-pill">Clip</span>
                    <strong>{template.name}</strong>
                    <span>{template.captionPlacement} captions with a {template.videoFillMode} frame treatment.</span>
                  </div>
                  <div className={`template-preview-caption template-preview-caption-${template.captionPlacement}`}>
                    <div
                      className={`approval-caption-chip approval-caption-${template.captionStyle} approval-caption-size-${template.captionSize}`}
                      style={{ color: template.captionColor, fontFamily: template.fontFamily }}
                    >
                      Decisions compound fast
                    </div>
                  </div>
                </div>
              </div>
              <div className="meta-grid">
                <div>
                  <span>Caption</span>
                  <strong>{template.captionStyle}</strong>
                </div>
                <div>
                  <span>Size</span>
                  <strong>{template.captionSize}</strong>
                </div>
                <div>
                  <span>Music</span>
                  <strong>{template.musicSrc ? `${template.musicVolume}%` : "Off"}</strong>
                </div>
                <div>
                  <span>Intro</span>
                  <strong>{template.introSrc ? "Attached" : "None"}</strong>
                </div>
                <div>
                  <span>Outro</span>
                  <strong>{template.outroSrc ? "Attached" : "None"}</strong>
                </div>
                <div>
                  <span>Placement</span>
                  <strong>{template.captionPlacement}</strong>
                </div>
                <div>
                  <span>Font</span>
                  <strong>{template.fontFamily}</strong>
                </div>
                <div>
                  <span>Music Asset</span>
                  <strong>{template.musicSrc ? "Attached" : "None"}</strong>
                </div>
              </div>
              <div className="card-actions">
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => {
                    setEditingId(template.id);
                    setDraft(toDraft(template));
                  }}
                >
                  Edit
                </button>
                <button
                  className="button button-danger"
                  type="button"
                  onClick={() => void deleteTemplate(template.id)}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
          {templates.length === 0 ? <div className="empty">Create your first clipping template to unlock approval.</div> : null}
        </div>
      </section>
    </div>
  );
}
