"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "@/lib/format";
import type { ClipSpan, RenderJob, RenderTemplate, RunDetail, SubtitleCue, TranscriptToken } from "@/lib/types";

type ExportItem = RenderJob & { title: string; hook: string; fileName: string | null };

type ManualRenderState = {
  start: string;
  end: string;
  title: string;
  hook: string;
  introSrc: string | null;
  introLabel: string;
};

type FormatSelection = {
  vertical: boolean;
  landscape: boolean;
};

type CandidateRenderState = {
  label: "queued" | "in progress" | "rendered" | "error";
  formats: RenderJob["format"][];
  errorMessage: string | null;
  renderIds: string[];
  progressPercent: number | null;
};

type SubtitleEditorState = {
  renderId: string;
  cues: SubtitleCue[];
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  rerendering: boolean;
};

type ActivePopover =
  | { candidateId: string; type: "error" }
  | null;

type TranscriptGroup = {
  id: string;
  startMs: number;
  endMs: number;
  tokens: TranscriptToken[];
};

function parseTimestampInput(value: string) {
  const parts = value.trim().split(":").map((part) => Number(part));
  if (parts.length === 0 || parts.some((part) => Number.isNaN(part) || part < 0)) {
    return null;
  }

  if (parts.length === 3) {
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  }

  if (parts.length === 2) {
    return (parts[0] * 60 + parts[1]) * 1000;
  }

  if (parts.length === 1) {
    return parts[0] * 1000;
  }

  return null;
}

function groupTranscript(tokens: TranscriptToken[], wordsPerGroup: number) {
  const groups: TranscriptGroup[] = [];

  for (let index = 0; index < tokens.length; index += wordsPerGroup) {
    const slice = tokens.slice(index, index + wordsPerGroup);
    if (slice.length === 0) {
      continue;
    }

    groups.push({
      id: slice.map((token) => token.id).join("-"),
      startMs: slice[0].startMs,
      endMs: slice[slice.length - 1].endMs,
      tokens: slice,
    });
  }

  return groups;
}

function humanizeErrorMessage(error: string | null) {
  if (!error) {
    return null;
  }

  if (error.includes("yt-dlp finished without leaving a usable media file")) {
    return "We likely reached the end of the available source video, so there was no next chunk to download.";
  }

  if (error.includes("Requested format is not available")) {
    return "This source does not expose a downloadable stream format we can use right now.";
  }

  if (error.includes("This format cannot be partially downloaded")) {
    return "This live source cannot be clipped chunk-by-chunk in its current format.";
  }

  if (error.includes("ECONNRESET") || error.includes("Target closed")) {
    return "The render browser lost connection while exporting the clip. Retrying usually fixes this.";
  }

  if (error.includes("No video stream found in input file")) {
    return "This clip was trimmed incorrectly and lost its video track before render. A retry will rebuild it from the source segments.";
  }

  if (error.includes("delayRender()")) {
    return "The clip media took too long to load during render, so the export timed out.";
  }

  if (error.includes("No such file or directory")) {
    return "Some older source media is missing on disk, so this clip can no longer be rebuilt.";
  }

  const cleaned = error
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.includes("ProtocolError")) {
    return "The render browser session closed unexpectedly while exporting the clip.";
  }

  if (cleaned.includes("Could not extract frame from compositor")) {
    return "The render engine could not decode the source clip correctly during export.";
  }

  return cleaned.split("\n")[0];
}

function compareByConfidence(left: { confidence: number }, right: { confidence: number }) {
  return right.confidence - left.confidence;
}

function getTranscriptSnippet(tokens: TranscriptToken[], startMs: number, endMs: number) {
  return tokens.filter((token) => token.startMs <= endMs && token.endMs >= startMs);
}

function candidateSpans(candidate: RunDetail["candidates"][number]) {
  return candidate.clipSpans && candidate.clipSpans.length > 0
    ? candidate.clipSpans
    : [{
        id: `${candidate.id}-continuous`,
        candidateId: candidate.id,
        runId: candidate.runId,
        sourceStartMs: candidate.suggestedStartMs,
        sourceEndMs: candidate.suggestedEndMs,
        outputStartMs: 0,
        outputEndMs: candidate.suggestedEndMs - candidate.suggestedStartMs,
        reason: "continuous",
        createdAt: candidate.createdAt,
      } satisfies ClipSpan];
}

function findPreviousToken(tokens: TranscriptToken[], startMs: number) {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].endMs < startMs) {
      return tokens[index];
    }
  }

  return null;
}

function findNextToken(tokens: TranscriptToken[], endMs: number) {
  for (const token of tokens) {
    if (token.startMs > endMs) {
      return token;
    }
  }

  return null;
}

function formatCueTime(ms: number) {
  const totalSeconds = Math.max(0, ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const millis = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
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

export function RunDetailClient({
  initialRun,
  initialExports,
  initialTemplates,
}: {
  initialRun: RunDetail;
  initialExports: ExportItem[];
  initialTemplates: RenderTemplate[];
}) {
  const [detail, setDetail] = useState(initialRun);
  const [exportsFeed, setExportsFeed] = useState(initialExports);
  const [templates, setTemplates] = useState(initialTemplates);
  const [manualRender, setManualRender] = useState<ManualRenderState>({
    start: "",
    end: "",
    title: "",
    hook: "",
    introSrc: null,
    introLabel: "None selected",
  });
  const [manualFormats, setManualFormats] = useState<FormatSelection>({
    vertical: false,
    landscape: true,
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activePopover, setActivePopover] = useState<ActivePopover>(null);
  const [transcriptModalCandidateId, setTranscriptModalCandidateId] = useState<string | null>(null);
  const [approvalModal, setApprovalModal] = useState<{ candidateId: string; templateId: string; introSrc: string | null; introLabel: string } | null>(null);
  const [editingCandidateField, setEditingCandidateField] = useState<{ candidateId: string; field: "title" | "hook" } | null>(null);
  const [editingCandidateText, setEditingCandidateText] = useState("");
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [editingTokenText, setEditingTokenText] = useState("");
  const [modalEditingTokenId, setModalEditingTokenId] = useState<string | null>(null);
  const [modalEditingTokenText, setModalEditingTokenText] = useState("");
  const [savingTokenId, setSavingTokenId] = useState<string | null>(null);
  const [introUploadScope, setIntroUploadScope] = useState<"manual" | "approval" | null>(null);
  const [subtitleEditor, setSubtitleEditor] = useState<SubtitleEditorState | null>(null);
  const [subtitleCurrentMs, setSubtitleCurrentMs] = useState(0);
  const subtitleVideoRef = useRef<HTMLVideoElement | null>(null);

  async function refresh() {
    const payload = await fetchJson<{ run: RunDetail }>(`/api/runs/${detail.run.id}`);
    const exportsPayload = await fetchJson<{ exports: ExportItem[] }>("/api/exports");
    const templatesPayload = await fetchJson<{ templates: RenderTemplate[] }>("/api/templates");

    startTransition(() => {
      setDetail(payload.run);
      setExportsFeed(exportsPayload.exports.filter((item) => item.runId === detail.run.id));
      setTemplates(templatesPayload.templates);
    });
  }

  function patchTokenInDetail(tokenId: string, text: string) {
    setDetail((current) => ({
      ...current,
      transcript: {
        ...current.transcript,
        tokens: current.transcript.tokens.map((token) =>
          token.id === tokenId ? { ...token, text } : token,
        ),
      },
      fullTranscriptTokens: current.fullTranscriptTokens.map((token) =>
        token.id === tokenId ? { ...token, text } : token,
      ),
    }));
  }

  function patchCandidateInDetail(candidateId: string, field: "title" | "hook", value: string) {
    setDetail((current) => ({
      ...current,
      candidates: current.candidates.map((candidate) =>
        candidate.id === candidateId ? { ...candidate, [field]: value } : candidate,
      ),
    }));
  }

  function patchCandidateWindowInDetail(candidateId: string, startMs: number, endMs: number) {
    setDetail((current) => ({
      ...current,
      candidates: current.candidates.map((candidate) =>
        candidate.id === candidateId
          ? { ...candidate, suggestedStartMs: startMs, suggestedEndMs: endMs, clipSpans: [] }
          : candidate,
      ),
    }));
  }

  function patchCandidateSpansInDetail(candidateId: string, clipSpans: ClipSpan[]) {
    setDetail((current) => ({
      ...current,
      candidates: current.candidates.map((candidate) =>
        candidate.id === candidateId ? { ...candidate, clipSpans } : candidate,
      ),
    }));
  }

  function startEditingCandidateField(candidateId: string, field: "title" | "hook", value: string) {
    setEditingCandidateField({ candidateId, field });
    setEditingCandidateText(value);
  }

  async function commitCandidateFieldEdit(
    candidate: RunDetail["candidates"][number],
    field: "title" | "hook",
  ) {
    const nextText = editingCandidateText.trim();
    setEditingCandidateField(null);

    if (!nextText || nextText === candidate[field]) {
      setEditingCandidateText("");
      return;
    }

    const previousText = candidate[field];
    patchCandidateInDetail(candidate.id, field, nextText);

    try {
      const payload = await fetchJson<{ candidate: RunDetail["candidates"][number] }>(`/api/candidates/${candidate.id}`, {
        method: "PATCH",
        body: JSON.stringify({ [field]: nextText }),
      });

      if (payload.candidate) {
        patchCandidateInDetail(candidate.id, "title", payload.candidate.title);
        patchCandidateInDetail(candidate.id, "hook", payload.candidate.hook);
      }
    } catch (error) {
      patchCandidateInDetail(candidate.id, field, previousText);
      setErrorMessage(error instanceof Error ? error.message : "Failed to update candidate copy.");
    } finally {
      setEditingCandidateText("");
    }
  }

  function startEditingToken(token: TranscriptToken) {
    setEditingTokenId(token.id);
    setEditingTokenText(token.text);
  }

  async function commitTokenEdit(token: TranscriptToken) {
    const nextText = editingTokenText.trim() ? editingTokenText.trim() : " ";
    setEditingTokenId(null);

    if (nextText === token.text) {
      setEditingTokenText("");
      return;
    }

    const previousText = token.text;
    patchTokenInDetail(token.id, nextText);
    setSavingTokenId(token.id);

    try {
      await fetchJson<{ token: TranscriptToken }>(`/api/transcript-tokens/${token.id}`, {
        method: "PATCH",
        body: JSON.stringify({ text: nextText }),
      });
    } catch (error) {
      patchTokenInDetail(token.id, previousText);
      setErrorMessage(error instanceof Error ? error.message : "Failed to update transcript token.");
    } finally {
      setSavingTokenId(null);
      setEditingTokenText("");
    }
  }

  useEffect(() => {
    const interval = setInterval(() => {
      if (editingTokenId || modalEditingTokenId || savingTokenId) {
        return;
      }
      void refresh().catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : "Failed to refresh run.");
      });
    }, 5000);

    return () => clearInterval(interval);
  }, [detail.run.id, editingTokenId, modalEditingTokenId, savingTokenId]);

  function startEditingModalToken(token: TranscriptToken) {
    setModalEditingTokenId(token.id);
    setModalEditingTokenText(token.text);
  }

  async function commitModalTokenEdit(token: TranscriptToken) {
    const nextText = modalEditingTokenText.trim() ? modalEditingTokenText.trim() : " ";
    setModalEditingTokenId(null);

    if (nextText === token.text) {
      setModalEditingTokenText("");
      return;
    }

    const previousText = token.text;
    patchTokenInDetail(token.id, nextText);
    setSavingTokenId(token.id);

    try {
      await fetchJson<{ token: TranscriptToken }>(`/api/transcript-tokens/${token.id}`, {
        method: "PATCH",
        body: JSON.stringify({ text: nextText }),
      });
    } catch (error) {
      patchTokenInDetail(token.id, previousText);
      setErrorMessage(error instanceof Error ? error.message : "Failed to update transcript token.");
    } finally {
      setSavingTokenId(null);
      setModalEditingTokenText("");
    }
  }

  async function adjustCandidateWindow(
    candidate: RunDetail["candidates"][number],
    edge: "start" | "end",
    direction: "expand" | "trim",
  ) {
    const snippet = getTranscriptSnippet(
      detail.fullTranscriptTokens,
      candidate.suggestedStartMs,
      candidate.suggestedEndMs,
    );

    if (snippet.length === 0) {
      return;
    }

    let nextStartMs = candidate.suggestedStartMs;
    let nextEndMs = candidate.suggestedEndMs;

    if (edge === "start" && direction === "expand") {
      const previousToken = findPreviousToken(detail.fullTranscriptTokens, snippet[0].startMs);
      if (!previousToken) {
        return;
      }
      nextStartMs = previousToken.startMs;
    }

    if (edge === "start" && direction === "trim") {
      const nextToken = snippet[1];
      if (!nextToken) {
        return;
      }
      nextStartMs = nextToken.startMs;
    }

    if (edge === "end" && direction === "expand") {
      const nextToken = findNextToken(detail.fullTranscriptTokens, snippet[snippet.length - 1].endMs);
      if (!nextToken) {
        return;
      }
      nextEndMs = nextToken.endMs;
    }

    if (edge === "end" && direction === "trim") {
      const previousToken = snippet[snippet.length - 2];
      if (!previousToken) {
        return;
      }
      nextEndMs = previousToken.endMs;
    }

    if (nextEndMs <= nextStartMs) {
      return;
    }

    patchCandidateWindowInDetail(candidate.id, nextStartMs, nextEndMs);

    try {
      const payload = await fetchJson<{ candidate: RunDetail["candidates"][number] }>(`/api/candidates/${candidate.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          suggestedStartMs: nextStartMs,
          suggestedEndMs: nextEndMs,
        }),
      });

      if (payload.candidate) {
        patchCandidateWindowInDetail(
          candidate.id,
          payload.candidate.suggestedStartMs,
          payload.candidate.suggestedEndMs,
        );
      }
    } catch (error) {
      patchCandidateWindowInDetail(candidate.id, candidate.suggestedStartMs, candidate.suggestedEndMs);
      setErrorMessage(error instanceof Error ? error.message : "Failed to update clip transcript range.");
    }
  }

  async function updateCandidateSpans(
    candidate: RunDetail["candidates"][number],
    spans: Array<{ sourceStartMs: number; sourceEndMs: number }>,
  ) {
    setErrorMessage(null);
    try {
      const payload = await fetchJson<{ candidate: RunDetail["candidates"][number] }>(`/api/candidates/${candidate.id}`, {
        method: "PATCH",
        body: JSON.stringify({ clipSpans: spans }),
      });

      if (payload.candidate) {
        patchCandidateSpansInDetail(candidate.id, payload.candidate.clipSpans ?? []);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update multi-clip segments.");
    }
  }

  function addCandidateSpan(candidate: RunDetail["candidates"][number], group: TranscriptGroup) {
    const spans = candidateSpans(candidate)
      .filter((span) => span.id !== `${candidate.id}-continuous`)
      .map((span) => ({
        sourceStartMs: span.sourceStartMs,
        sourceEndMs: span.sourceEndMs,
      }));
    const nextSpan = {
      sourceStartMs: Math.max(candidate.suggestedStartMs, group.startMs),
      sourceEndMs: Math.min(candidate.suggestedEndMs, group.endMs),
    };
    const alreadyExists = spans.some(
      (span) => span.sourceStartMs === nextSpan.sourceStartMs && span.sourceEndMs === nextSpan.sourceEndMs,
    );
    if (alreadyExists || nextSpan.sourceEndMs <= nextSpan.sourceStartMs) {
      return;
    }

    void updateCandidateSpans(candidate, [...spans, nextSpan]);
  }

  function removeCandidateSpan(candidate: RunDetail["candidates"][number], removeIndex: number) {
    const spans = candidateSpans(candidate)
      .filter((span) => span.id !== `${candidate.id}-continuous`)
      .filter((_, index) => index !== removeIndex)
      .map((span) => ({
        sourceStartMs: span.sourceStartMs,
        sourceEndMs: span.sourceEndMs,
      }));

    void updateCandidateSpans(candidate, spans);
  }

  async function approveCandidate(candidateId: string, templateId: string) {
    setErrorMessage(null);
    if (!templateId || templateId === "__new__") {
      setErrorMessage("Choose a template before approving this clip.");
      return;
    }

    await fetchJson(`/api/candidates/${candidateId}/approve`, {
      method: "POST",
      body: JSON.stringify({
        templateId,
        introSrc: approvalModal?.candidateId === candidateId ? approvalModal.introSrc : null,
      }),
    });
    setApprovalModal(null);
    await refresh();
  }

  async function handleIntroUpload(
    scope: "manual" | "approval",
    file: File | null,
  ) {
    if (!file) {
      if (scope === "manual") {
        setManualRender((current) => ({ ...current, introSrc: null, introLabel: "None selected" }));
        return;
      }

      setApprovalModal((current) =>
        current ? { ...current, introSrc: null, introLabel: "None selected" } : current,
      );
      return;
    }

    setErrorMessage(null);
    setIntroUploadScope(scope);

    try {
      const uploaded = await uploadAsset(file);
      if (scope === "manual") {
        setManualRender((current) => ({
          ...current,
          introSrc: uploaded.asset.publicSrc,
          introLabel: uploaded.asset.label,
        }));
        return;
      }

      setApprovalModal((current) =>
        current
          ? { ...current, introSrc: uploaded.asset.publicSrc, introLabel: uploaded.asset.label }
          : current,
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not upload intro asset.");
    } finally {
      setIntroUploadScope((current) => (current === scope ? null : current));
    }
  }

  async function rejectCandidate(candidateId: string) {
    setErrorMessage(null);
    await fetchJson(`/api/candidates/${candidateId}/reject`, { method: "POST" });
    await refresh();
  }

  async function stopRun() {
    setErrorMessage(null);
    await fetchJson(`/api/runs/${detail.run.id}/stop`, { method: "POST" });
    await refresh();
  }

  async function toggleAutoApproval() {
    setErrorMessage(null);
    const nextValue = !detail.run.autoApproveClips;
    try {
      const payload = await fetchJson<{ run: RunDetail }>(`/api/runs/${detail.run.id}`, {
        method: "PATCH",
        body: JSON.stringify({ autoApproveClips: nextValue }),
      });
      setDetail(payload.run);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update auto-approval.");
    }
  }

  async function submitManualRender(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const startMs = parseTimestampInput(manualRender.start);
    const endMs = parseTimestampInput(manualRender.end);

    if (startMs === null || endMs === null) {
      setErrorMessage("Use timestamps like 00:01:30 or 90.");
      return;
    }

    if (endMs <= startMs) {
      setErrorMessage("End timestamp must be after start timestamp.");
      return;
    }

    setErrorMessage(null);
    const formats = [
      ...(manualFormats.vertical ? ["vertical" as const] : []),
      ...(manualFormats.landscape ? ["landscape" as const] : []),
    ];

    if (formats.length === 0) {
      setErrorMessage("Pick at least one format for the manual render.");
      return;
    }

    await fetchJson(`/api/runs/${detail.run.id}/manual-render`, {
      method: "POST",
      body: JSON.stringify({
        startMs,
        endMs,
        title: manualRender.title || undefined,
        hook: manualRender.hook || undefined,
        introSrc: manualRender.introSrc ?? undefined,
        formats,
      }),
    });

    setManualRender({ start: "", end: "", title: "", hook: "", introSrc: null, introLabel: "None selected" });
    await refresh();
  }

  async function openSubtitleEditor(renderId: string) {
    setErrorMessage(null);
    setSubtitleEditor({
      renderId,
      cues: [],
      dirty: false,
      loading: true,
      saving: false,
      rerendering: false,
    });

    try {
      const payload = await fetchJson<{ cues: SubtitleCue[] }>(`/api/exports/${renderId}/subtitles`);
      setSubtitleEditor({
        renderId,
        cues: payload.cues,
        dirty: false,
        loading: false,
        saving: false,
        rerendering: false,
      });
      setSubtitleCurrentMs(0);
    } catch (error) {
      setSubtitleEditor(null);
      setErrorMessage(error instanceof Error ? error.message : "Failed to load subtitles.");
    }
  }

  function patchSubtitleCues(updater: (cues: SubtitleCue[]) => SubtitleCue[]) {
    setSubtitleEditor((current) =>
      current
        ? {
            ...current,
            dirty: true,
            cues: updater(current.cues)
              .sort((left, right) => left.startMs - right.startMs)
              .map((cue, cueIndex) => ({ ...cue, cueIndex })),
          }
        : current,
    );
  }

  async function resetSubtitleCues() {
    if (!subtitleEditor) {
      return;
    }

    setSubtitleEditor((current) => current ? { ...current, loading: true } : current);
    try {
      const payload = await fetchJson<{ cues: SubtitleCue[] }>(
        `/api/exports/${subtitleEditor.renderId}/subtitles/reset`,
        { method: "POST" },
      );
      setSubtitleEditor((current) =>
        current
          ? {
              ...current,
              cues: payload.cues,
              dirty: false,
              loading: false,
            }
          : current,
      );
    } catch (error) {
      setSubtitleEditor((current) => current ? { ...current, loading: false } : current);
      setErrorMessage(error instanceof Error ? error.message : "Failed to reset subtitles.");
    }
  }

  function closeSubtitleEditor() {
    if (subtitleEditor?.dirty && !window.confirm("Close without saving subtitle changes?")) {
      return;
    }

    setSubtitleEditor(null);
  }

  async function saveSubtitleCues() {
    if (!subtitleEditor) {
      return false;
    }

    setSubtitleEditor((current) => current ? { ...current, saving: true } : current);
    try {
      const payload = await fetchJson<{ cues: SubtitleCue[] }>(`/api/exports/${subtitleEditor.renderId}/subtitles`, {
        method: "PATCH",
        body: JSON.stringify({
          cues: subtitleEditor.cues.map((cue) => ({
            text: cue.text,
            startMs: cue.startMs,
            endMs: cue.endMs,
            isHidden: cue.isHidden,
            sourceTokenIds: cue.sourceTokenIds,
          })),
        }),
      });
      setSubtitleEditor((current) =>
        current
          ? {
              ...current,
              cues: payload.cues,
              dirty: false,
              saving: false,
            }
          : current,
      );
      return true;
    } catch (error) {
      setSubtitleEditor((current) => current ? { ...current, saving: false } : current);
      setErrorMessage(error instanceof Error ? error.message : "Failed to save subtitles.");
      return false;
    }
  }

  async function rerenderEditedSubtitles() {
    if (!subtitleEditor) {
      return;
    }

    if (subtitleEditor.dirty) {
      const saved = await saveSubtitleCues();
      if (!saved) {
        return;
      }
    }

    setSubtitleEditor((current) => current ? { ...current, rerendering: true } : current);
    try {
      await fetchJson(`/api/exports/${subtitleEditor.renderId}/subtitles/rerender`, {
        method: "POST",
      });
      setSubtitleEditor(null);
      await refresh();
    } catch (error) {
      setSubtitleEditor((current) => current ? { ...current, rerendering: false } : current);
      setErrorMessage(error instanceof Error ? error.message : "Failed to queue subtitle rerender.");
    }
  }

  function seekSubtitleCue(cue: SubtitleCue) {
    if (subtitleVideoRef.current) {
      subtitleVideoRef.current.currentTime = cue.startMs / 1000;
      setSubtitleCurrentMs(cue.startMs);
    }
  }

  function nudgeSubtitleCue(cueId: string, edge: "start" | "end", deltaMs: number) {
    patchSubtitleCues((cues) =>
      cues.map((cue) => {
        if (cue.id !== cueId) {
          return cue;
        }

        const nextStartMs = edge === "start"
          ? Math.max(0, Math.min(cue.startMs + deltaMs, cue.endMs - 120))
          : cue.startMs;
        const nextEndMs = edge === "end"
          ? Math.max(cue.startMs + 120, cue.endMs + deltaMs)
          : cue.endMs;
        return { ...cue, startMs: nextStartMs, endMs: nextEndMs };
      }),
    );
  }

  function splitSubtitleCue(cue: SubtitleCue) {
    const splitMs = Math.round(subtitleCurrentMs);
    if (splitMs <= cue.startMs + 250 || splitMs >= cue.endMs - 250) {
      return;
    }

    const words = cue.text.trim().split(/\s+/).filter(Boolean);
    const midpoint = Math.max(1, Math.min(words.length - 1, Math.round(words.length * ((splitMs - cue.startMs) / (cue.endMs - cue.startMs)))));
    const firstText = words.slice(0, midpoint).join(" ") || cue.text;
    const secondText = words.slice(midpoint).join(" ") || cue.text;
    patchSubtitleCues((cues) =>
      cues.flatMap((item) => {
        if (item.id !== cue.id) {
          return [item];
        }

        return [
          { ...item, text: firstText, endMs: splitMs },
          {
            ...item,
            id: `${item.id}_split_${Date.now()}`,
            text: secondText,
            startMs: splitMs,
            endMs: item.endMs,
            editSource: "user" as const,
          },
        ];
      }),
    );
  }

  function mergeSubtitleCueWithNext(cue: SubtitleCue) {
    patchSubtitleCues((cues) => {
      const index = cues.findIndex((item) => item.id === cue.id);
      if (index < 0 || index >= cues.length - 1) {
        return cues;
      }

      const next = cues[index + 1];
      return [
        ...cues.slice(0, index),
        {
          ...cue,
          text: `${cue.text.trim()} ${next.text.trim()}`.trim(),
          endMs: next.endMs,
          sourceTokenIds: [...cue.sourceTokenIds, ...next.sourceTokenIds],
          editSource: "user" as const,
        },
        ...cues.slice(index + 2),
      ];
    });
  }

  const rollingTranscriptGroups = useMemo(
    () => groupTranscript(detail.transcript.tokens, 10),
    [detail.transcript.tokens],
  );
  const fullTranscriptGroups = useMemo(
    () => groupTranscript(detail.fullTranscriptTokens, 16),
    [detail.fullTranscriptTokens],
  );
  const transcriptCoverageMs = useMemo(
    () => detail.fullTranscriptTokens.reduce((maxMs, token) => Math.max(maxMs, token.endMs), 0),
    [detail.fullTranscriptTokens],
  );
  const displayedCapturedMs = useMemo(() => {
    if (detail.run.status === "active") {
      return detail.capturedMediaMs;
    }

    return transcriptCoverageMs > 0 ? Math.min(detail.capturedMediaMs, transcriptCoverageMs) : detail.capturedMediaMs;
  }, [detail.capturedMediaMs, detail.run.status, transcriptCoverageMs]);

  function isShortlistedRange(startMs: number, endMs: number) {
    return detail.candidates.some(
      (candidate) =>
        candidate.status !== "rejected" &&
        candidate.suggestedEndMs > startMs &&
        candidate.suggestedStartMs < endMs,
    );
  }

  function renderTranscriptTokens(tokens: TranscriptToken[], options?: { highlight?: boolean; modal?: boolean }) {
    if (tokens.length === 0) {
      return <div className="empty">Transcript for this range is still being processed.</div>;
    }

    return (
      <div className="transcript-copy">
        {tokens.map((token) => {
          const isEditing = editingTokenId === token.id;
          const isSaving = savingTokenId === token.id;
          const isHighlighted = options?.highlight && isShortlistedRange(token.startMs, token.endMs);

          return (
            <span
              key={token.id}
              className={`transcript-token ${options?.modal ? "transcript-token-modal" : ""} ${isHighlighted ? "transcript-token-highlight" : ""} ${isSaving ? "transcript-token-saving" : ""}`}
            >
              {isEditing ? (
                <input
                  className="transcript-token-input"
                  value={editingTokenText}
                  autoFocus
                  spellCheck={false}
                  onChange={(event) => setEditingTokenText(event.target.value)}
                  onBlur={() => void commitTokenEdit(token)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitTokenEdit(token);
                    }

                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingTokenId(null);
                      setEditingTokenText("");
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="transcript-token-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    startEditingToken(token);
                  }}
                >
                  {token.text.trim() || "×"}
                </button>
              )}
            </span>
          );
        })}
      </div>
    );
  }

  function renderTranscriptModalTokens(tokens: TranscriptToken[]) {
    if (tokens.length === 0) {
      return <div className="empty">Transcript for this range is still being processed.</div>;
    }

    return (
      <div className="transcript-copy">
        {tokens.map((token) => {
          const isEditing = modalEditingTokenId === token.id;
          const isSaving = savingTokenId === token.id;

          return (
            <span
              key={`modal-${token.id}`}
              className={`transcript-token transcript-token-modal ${isSaving ? "transcript-token-saving" : ""}`}
            >
              {isEditing ? (
                <input
                  className="transcript-token-input transcript-token-input-modal"
                  value={modalEditingTokenText}
                  autoFocus
                  spellCheck={false}
                  onChange={(event) => setModalEditingTokenText(event.target.value)}
                  onBlur={() => void commitModalTokenEdit(token)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitModalTokenEdit(token);
                    }

                    if (event.key === "Escape") {
                      event.preventDefault();
                      setModalEditingTokenId(null);
                      setModalEditingTokenText("");
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="transcript-token-button transcript-token-button-modal"
                  onClick={() => startEditingModalToken(token)}
                >
                  {token.text.trim() || "×"}
                </button>
              )}
            </span>
          );
        })}
      </div>
    );
  }

  function getCandidateRenderState(candidateId: string): CandidateRenderState {
    const jobs = detail.renderJobs
      .filter((renderJob) => renderJob.candidateId === candidateId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    if (jobs.length === 0) {
      return {
        label: "queued",
        formats: [],
        errorMessage: null,
        renderIds: [],
        progressPercent: null,
      };
    }

    const latestByFormat = new Map<RenderJob["format"], RenderJob>();
    for (const job of jobs) {
      if (!latestByFormat.has(job.format)) {
        latestByFormat.set(job.format, job);
      }
    }
    const currentJobs = Array.from(latestByFormat.values());
    const formats = currentJobs.map((job) => job.format);

    const renderingJobs = currentJobs.filter((job) => job.status === "rendering");
    if (renderingJobs.length > 0) {
      return {
        label: "in progress",
        formats,
        errorMessage: null,
        renderIds: renderingJobs.map((job) => job.id),
        progressPercent: Math.max(3, ...renderingJobs.map((job) => job.progressPercent ?? 0)),
      };
    }

    if (currentJobs.some((job) => job.status === "pending")) {
      return {
        label: "queued",
        formats,
        errorMessage: null,
        renderIds: currentJobs.map((job) => job.id),
        progressPercent: null,
      };
    }

    if (currentJobs.length > 0 && currentJobs.every((job) => job.status === "rendered")) {
      return {
        label: "rendered",
        formats,
        errorMessage: null,
        renderIds: currentJobs.map((job) => job.id),
        progressPercent: null,
      };
    }

    const latestError = currentJobs.find((job) => job.status === "error");
    return {
      label: "error",
      formats,
      errorMessage: latestError?.errorMessage ?? null,
      renderIds: currentJobs.map((job) => job.id),
      progressPercent: null,
    };
  }

  const renderStates = useMemo(() => {
    return Object.fromEntries(
      detail.candidates.map((candidate) => [candidate.id, getCandidateRenderState(candidate.id)]),
    ) as Record<string, CandidateRenderState>;
  }, [detail.candidates, detail.renderJobs]);

  const pendingCandidates = useMemo(() => {
    const renderedCandidateIds = new Set(
      detail.renderJobs
        .filter((renderJob) => renderJob.status === "rendered")
        .map((renderJob) => renderJob.candidateId),
    );

    const readyToApprove = detail.candidates
      .filter((candidate) => {
        const renderState = renderStates[candidate.id];
        if (renderedCandidateIds.has(candidate.id)) {
          return false;
        }
        return candidate.status === "pending" || (candidate.status === "approved" && renderState?.label === "error");
      })
      .sort(compareByConfidence);

    const inProgress = detail.candidates
      .filter((candidate) => {
        if (renderedCandidateIds.has(candidate.id)) {
          return false;
        }

        return candidate.status === "approved" && renderStates[candidate.id]?.label === "in progress";
      })
      .sort(compareByConfidence);

    return [...readyToApprove, ...inProgress];
  }, [detail.candidates, detail.renderJobs, renderStates]);

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
            <Link className="eyebrow-link" href="/templates">
              Templates
            </Link>
            <span className="eyebrow">Run</span>
          </div>
          <h1 className="page-title">{detail.run.label}</h1>
          <div className="run-card-subline">
            <div className="run-card-stats">
              <span className="muted">{detail.run.platform}</span>
              <span className="muted">{detail.candidates.filter((candidate) => candidate.status === "pending").length} pending clips</span>
              <span className="muted">{exportsFeed.length} rendered clips</span>
            </div>
            <a
              className="url-icon-button"
              href={detail.run.sourceUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Open source URL"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d="M11.5 5.5h3v3M10.5 9.5l4-4M8.5 4.5h-3A1.5 1.5 0 0 0 4 6v8a1.5 1.5 0 0 0 1.5 1.5h8A1.5 1.5 0 0 0 15 14v-3"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.4"
                />
              </svg>
            </a>
          </div>
        </div>
        <div className="button-row">
          <button className="button button-secondary" type="button" onClick={() => void refresh()}>
            Refresh
          </button>
          <button
            className={`button ${detail.run.autoApproveClips ? "button-primary" : "button-secondary"}`}
            type="button"
            onClick={() => void toggleAutoApproval()}
          >
            Auto-Approval {detail.run.autoApproveClips ? "On" : "Off"}
          </button>
          <button
            className="button button-danger"
            type="button"
            disabled={detail.run.status !== "active"}
            onClick={() => void stopRun()}
          >
            Stop Run
          </button>
        </div>
      </div>

      {errorMessage ? (
        <p className="footer-note" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {detail.run.errorMessage ? (
        <p className="callout callout-error" style={{ marginTop: 16 }}>
          {humanizeErrorMessage(detail.run.errorMessage)}
        </p>
      ) : null}

      <div className="workspace-stack">
        <section className="panel">
          <div className="panel-title">
            <h2>Run Status</h2>
            <span className={`pill status-${detail.run.status}`}>{detail.run.status}</span>
          </div>
          <div className="status-strip">
            <div className="status-chip">
              <span>Platform</span>
              <strong>{detail.run.platform}</strong>
            </div>
            <div className="status-chip">
              <span>Source Mode</span>
              <strong>
                {detail.run.lastCaptureErrorCode === "needs_auth"
                  ? "Needs auth"
                  : detail.run.sourceMode === "vod"
                    ? "VOD audio-first"
                    : detail.run.sourceMode === "live"
                      ? "Live rolling"
                      : detail.run.lastCaptureErrorCode === "stream_ended"
                        ? "Ended"
                        : detail.run.sourceMode}
              </strong>
            </div>
            <div className="status-chip">
              <span>Media Strategy</span>
              <strong>{detail.run.sourceMediaStrategy}</strong>
            </div>
            <div className="status-chip">
              <span>Captured</span>
              <strong>{formatDuration(displayedCapturedMs)}</strong>
            </div>
            <div className="status-chip">
              <span>Last Segment</span>
              <strong className="mono">
                {detail.run.lastSegmentAt ? new Date(detail.run.lastSegmentAt).toLocaleTimeString() : "—"}
              </strong>
            </div>
            <div className="status-chip">
              <span>Retention</span>
              <strong className="mono">
                {detail.run.tempVideoRetentionMs ? `${Math.round(detail.run.tempVideoRetentionMs / 60_000)}m` : "—"}
              </strong>
            </div>
            <div className="status-chip">
              <span>Last Analysis</span>
              <strong className="mono">
                {detail.run.lastAnalysisAt ? new Date(detail.run.lastAnalysisAt).toLocaleTimeString() : "—"}
              </strong>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Manual Render</h2>
            <span className="pill mono pill-muted">Choose formats</span>
          </div>
          <form className="url-form" onSubmit={submitManualRender}>
            <div className="grid-2">
              <div>
                <label className="field-label" htmlFor="manual-start">
                  Start
                </label>
                <input
                  id="manual-start"
                  className="text-input"
                  placeholder="00:01:30"
                  value={manualRender.start}
                  onChange={(event) => setManualRender((current) => ({ ...current, start: event.target.value }))}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="manual-end">
                  End
                </label>
                <input
                  id="manual-end"
                  className="text-input"
                  placeholder="00:02:10"
                  value={manualRender.end}
                  onChange={(event) => setManualRender((current) => ({ ...current, end: event.target.value }))}
                />
              </div>
            </div>
            <div className="grid-2">
              <div>
                <label className="field-label" htmlFor="manual-title">
                  Title
                </label>
                <input
                  id="manual-title"
                  className="text-input"
                  placeholder="Clip title"
                  value={manualRender.title}
                  onChange={(event) => setManualRender((current) => ({ ...current, title: event.target.value }))}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="manual-hook">
                  Hook
                </label>
                <input
                  id="manual-hook"
                  className="text-input"
                  placeholder="Optional subheading"
                  value={manualRender.hook}
                  onChange={(event) => setManualRender((current) => ({ ...current, hook: event.target.value }))}
                />
              </div>
            </div>
            <div>
              <label className="field-label" htmlFor="manual-intro">
                Clip Intro
              </label>
              <input
                id="manual-intro"
                className="file-input"
                type="file"
                accept="image/*,video/*"
                onChange={(event) => void handleIntroUpload("manual", event.target.files?.[0] ?? null)}
              />
              <p className="field-hint">Current asset: {manualRender.introLabel}</p>
            </div>
            <div>
              <span className="field-label">Output Formats</span>
              <div className="format-chip-row">
                {(["landscape", "vertical"] as const).map((format) => {
                  const selected = manualFormats[format];
                  return (
                    <button
                      key={format}
                      className={`chip-toggle ${selected ? "chip-toggle-active" : ""}`}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setManualFormats((current) => ({
                          ...current,
                          [format]: !current[format],
                        }))
                      }
                    >
                      {format}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="button-row">
              <button className="button button-primary" type="submit">
                Queue Render
              </button>
            </div>
          </form>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Pending Clips</h2>
            <span className="pill mono">{pendingCandidates.length} waiting</span>
          </div>
          <div className="horizontal-scroll">
            {pendingCandidates.length === 0 ? (
              <div className="empty">Pending clip suggestions will appear here after transcript analysis.</div>
            ) : null}
            {pendingCandidates.map((candidate) => (
              <article className="candidate-card" key={candidate.id}>
                {(() => {
                  const renderState = renderStates[candidate.id];
                  const candidateStatus =
                    candidate.status === "pending"
                      ? "pending"
                      : renderState?.label === "in progress" || renderState?.label === "queued"
                        ? "in progress"
                        : "error";
                  const clipDuration = candidate.suggestedEndMs - candidate.suggestedStartMs;
                  const popoverType = activePopover?.candidateId === candidate.id ? activePopover.type : null;
                  return (
                    <>
                <div className="candidate-card-header">
                  <div>
                    {editingCandidateField?.candidateId === candidate.id && editingCandidateField.field === "title" ? (
                      <input
                        className="inline-edit-input inline-edit-title"
                        value={editingCandidateText}
                        autoFocus
                        onChange={(event) => setEditingCandidateText(event.target.value)}
                        onBlur={() => void commitCandidateFieldEdit(candidate, "title")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void commitCandidateFieldEdit(candidate, "title");
                          }

                          if (event.key === "Escape") {
                            event.preventDefault();
                            setEditingCandidateField(null);
                            setEditingCandidateText("");
                          }
                        }}
                      />
                    ) : (
                      <h4
                        onDoubleClick={() => startEditingCandidateField(candidate.id, "title", candidate.title)}
                        title="Double click to edit"
                      >
                        {candidate.title}
                      </h4>
                    )}
                    {editingCandidateField?.candidateId === candidate.id && editingCandidateField.field === "hook" ? (
                      <input
                        className="inline-edit-input inline-edit-hook"
                        value={editingCandidateText}
                        autoFocus
                        onChange={(event) => setEditingCandidateText(event.target.value)}
                        onBlur={() => void commitCandidateFieldEdit(candidate, "hook")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void commitCandidateFieldEdit(candidate, "hook");
                          }

                          if (event.key === "Escape") {
                            event.preventDefault();
                            setEditingCandidateField(null);
                            setEditingCandidateText("");
                          }
                        }}
                      />
                    ) : (
                      <p
                        className="run-url editable-copy"
                        onDoubleClick={() => startEditingCandidateField(candidate.id, "hook", candidate.hook)}
                        title="Double click to edit"
                      >
                        {candidate.hook}
                      </p>
                    )}
                  </div>
                  <div className="card-header-actions">
                    <button
                      className={`icon-button ${transcriptModalCandidateId === candidate.id ? "icon-button-active" : ""}`}
                      type="button"
                      aria-label="Read transcript excerpt"
                      onClick={() => setTranscriptModalCandidateId(candidate.id)}
                    >
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <path
                          d="M4 4.5A1.5 1.5 0 0 1 5.5 3h9A1.5 1.5 0 0 1 16 4.5v11a.5.5 0 0 1-.8.4L12.5 14H5.5A1.5 1.5 0 0 1 4 12.5v-8Z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinejoin="round"
                        />
                        <path d="M7 7h6M7 9.75h6M7 12.5h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                      </svg>
                    </button>
                    {candidateStatus === "error" ? (
                      <button
                        className={`icon-button ${popoverType === "error" ? "icon-button-active" : ""}`}
                        type="button"
                        aria-label="Show render error details"
                        onClick={() =>
                          setActivePopover((current) =>
                            current?.candidateId === candidate.id && current.type === "error"
                              ? null
                              : { candidateId: candidate.id, type: "error" },
                          )
                        }
                      >
                        <svg viewBox="0 0 20 20" aria-hidden="true">
                          <path
                            d="M10 3.5 17 16.5H3L10 3.5Zm0 4.2v3.8m0 2.7h.01"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    ) : null}
                    <span
                      className={`pill status-${
                        candidateStatus === "in progress"
                          ? "rendering"
                          : candidateStatus === "error"
                            ? "error"
                            : "pending"
                      }`}
                    >
                      {candidateStatus === "in progress" && renderState?.progressPercent !== null
                        ? `${Math.round(renderState.progressPercent)}%`
                        : candidateStatus === "in progress"
                          ? "queued"
                        : candidateStatus === "error"
                          ? "error"
                          : candidateStatus}
                    </span>
                  </div>
                </div>
                {popoverType === "error" ? (
                  <div className="floating-cloud" role="dialog" aria-label="Error details">
                    <div className="floating-cloud-title">
                      Error details
                    </div>
                    <p className="floating-cloud-copy">
                      {humanizeErrorMessage(renderState?.errorMessage)}
                    </p>
                  </div>
                ) : null}
                <div className="badge-row">
                    <span className="pill mono">
                      {formatDuration(candidate.suggestedStartMs)} - {formatDuration(candidate.suggestedEndMs)} ({formatDuration(clipDuration)})
                    </span>
                    <span className="pill mono">{Math.round(candidate.confidence * 100)}% confidence</span>
                  </div>
                  {candidate.renderConfig?.templateName ? (
                    <div className="badge-row">
                      <span className="pill mono">{candidate.renderConfig.templateName}</span>
                    </div>
                  ) : null}
                  <p className="candidate-reason">{candidate.reason}</p>
                <div className="card-actions">
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={candidateStatus === "in progress"}
                    onClick={() =>
                      setApprovalModal({
                        candidateId: candidate.id,
                        templateId: candidate.renderConfig?.templateId ?? "",
                        introSrc: candidate.renderConfig?.introSrc ?? null,
                        introLabel: candidate.renderConfig?.introSrc
                          ? candidate.renderConfig.introSrc.split("/").pop() ?? "Attached"
                          : "None selected",
                      })
                    }
                  >
                    {candidateStatus === "error" ? "Retry Render" : "Approve Clip"}
                  </button>
                  <button
                    className="button button-danger"
                    type="button"
                    disabled={candidateStatus === "in progress"}
                    onClick={() => void rejectCandidate(candidate.id)}
                  >
                    Reject Clip
                  </button>
                </div>
                    </>
                  );
                })()}
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Transcript</h2>
            <span className="pill mono">{detail.fullTranscriptTokens.length} tokens</span>
          </div>
          <div className="transcript-grid">
            <div className="flat-subsection">
              <div className="panel-title">
                <h3>Recent Window</h3>
                <span className="pill mono">
                  {formatDuration(detail.transcript.startedAtMs)} - {formatDuration(detail.transcript.endedAtMs)}
                </span>
              </div>
              <div className="transcript-rows">
                {rollingTranscriptGroups.length === 0 ? (
                  <div className="empty">The current rolling transcript will appear here as segments finish.</div>
                ) : null}
                {rollingTranscriptGroups.map((group) => (
                  <div className="transcript-row" key={group.id}>
                    <div className="transcript-time mono">
                      {formatDuration(group.startMs)} - {formatDuration(group.endMs)}
                    </div>
                    {renderTranscriptTokens(group.tokens)}
                  </div>
                ))}
              </div>
            </div>

            <div className="flat-subsection">
              <div className="panel-title">
                <h3>Full Transcript</h3>
                <span className="pill mono">scrollable</span>
              </div>
              <div className="transcript-rows transcript-rows-tall">
                {fullTranscriptGroups.length === 0 ? (
                  <div className="empty">The full transcript will build up here as the source is processed.</div>
                ) : null}
                {fullTranscriptGroups.map((group) => (
                  <div
                    className={`transcript-row ${isShortlistedRange(group.startMs, group.endMs) ? "transcript-row-highlight" : ""}`}
                    key={group.id}
                  >
                    <div className="transcript-time mono">
                      {formatDuration(group.startMs)} - {formatDuration(group.endMs)}
                    </div>
                    {renderTranscriptTokens(group.tokens, { highlight: true })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Rendered Videos</h2>
            <span className="pill mono">{exportsFeed.length} exports</span>
          </div>
          <div className="horizontal-scroll">
            {exportsFeed.length === 0 ? (
              <div className="empty">Rendered clips will show up here.</div>
            ) : null}
            {exportsFeed.map((item) => (
              <article className="export-card" key={item.id}>
                <video
                  className="export-preview"
                  src={`/api/exports/${item.id}/video`}
                  muted
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(event) => {
                    try {
                      const duration = Number.isFinite(event.currentTarget.duration)
                        ? event.currentTarget.duration
                        : 0;
                      event.currentTarget.currentTime = duration > 0 ? duration / 2 : 0.1;
                    } catch {}
                  }}
                  onSeeked={(event) => {
                    event.currentTarget.pause();
                  }}
                />
                <div className="export-card-header">
                  <div>
                    <h4>{item.title}</h4>
                    <p className="run-url">{item.hook}</p>
                    <p className="mono muted">{item.fileName ?? item.id}</p>
                  </div>
                  <div className="badge-row badge-row-tight">
                    <span className="pill mono">{item.format}</span>
                    <span className={`pill status-${item.status}`}>{item.status}</span>
                    <span className="pill mono">{item.driveUploadStatus.replace("_", " ")}</span>
                  </div>
                </div>
                <div className="card-actions">
                  <a
                    className="button button-primary"
                    href={`/api/exports/${item.id}/video`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Play
                  </a>
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={() => void openSubtitleEditor(item.id)}
                  >
                    Edit subtitles
                  </button>
                  {item.driveWebViewLink ? (
                    <a
                      className="button button-secondary"
                      href={item.driveWebViewLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Drive
                    </a>
                  ) : item.driveErrorMessage ? (
                    <span className="pill status-error">{humanizeErrorMessage(item.driveErrorMessage)}</span>
                  ) : null}
                  <a
                    className="button button-secondary"
                    href={`/api/exports/${item.id}/resolve`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    DaVinci
                  </a>
                </div>
                </article>
            ))}
          </div>
        </section>
      </div>
      {transcriptModalCandidateId ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setTranscriptModalCandidateId(null)}
        >
          <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2>Transcript excerpt</h2>
              <button className="button button-secondary" type="button" onClick={() => setTranscriptModalCandidateId(null)}>
                Close
              </button>
            </div>
            {(() => {
              const candidate = detail.candidates.find((item) => item.id === transcriptModalCandidateId);
              if (!candidate) {
                return <p className="muted">This clip is no longer available.</p>;
              }

              const snippetTokens = getTranscriptSnippet(
                detail.fullTranscriptTokens,
                candidate.suggestedStartMs,
                candidate.suggestedEndMs,
              );
              const canExpandStart = Boolean(findPreviousToken(detail.fullTranscriptTokens, snippetTokens[0]?.startMs ?? candidate.suggestedStartMs));
              const canTrimStart = snippetTokens.length > 1;
              const canExpandEnd = Boolean(findNextToken(detail.fullTranscriptTokens, snippetTokens[snippetTokens.length - 1]?.endMs ?? candidate.suggestedEndMs));
              const canTrimEnd = snippetTokens.length > 1;
              const spans = candidateSpans(candidate).filter((span) => span.id !== `${candidate.id}-continuous`);
              const snippetGroups = groupTranscript(snippetTokens, 8);

              return (
                <div className="modal-content">
                  <div className="transcript-range-toolbar">
                    <div className="transcript-range-controls">
                      <button
                        className="range-stepper"
                        type="button"
                        disabled={!canExpandStart}
                        onClick={() => void adjustCandidateWindow(candidate, "start", "expand")}
                        aria-label="Add one word at the beginning"
                      >
                        +
                      </button>
                      <button
                        className="range-stepper"
                        type="button"
                        disabled={!canTrimStart}
                        onClick={() => void adjustCandidateWindow(candidate, "start", "trim")}
                        aria-label="Remove the first word"
                      >
                        -
                      </button>
                    </div>
                    <span className="pill mono">
                      {formatDuration(candidate.suggestedStartMs)} - {formatDuration(candidate.suggestedEndMs)} ({formatDuration(candidate.suggestedEndMs - candidate.suggestedStartMs)})
                    </span>
                    <div className="transcript-range-controls">
                      <button
                        className="range-stepper"
                        type="button"
                        disabled={!canExpandEnd}
                        onClick={() => void adjustCandidateWindow(candidate, "end", "expand")}
                        aria-label="Add one word at the end"
                      >
                        +
                      </button>
                      <button
                        className="range-stepper"
                        type="button"
                        disabled={!canTrimEnd}
                        onClick={() => void adjustCandidateWindow(candidate, "end", "trim")}
                        aria-label="Remove the last word"
                      >
                        -
                      </button>
                    </div>
                  </div>
                  <div className="transcript-modal-copy">
                    {renderTranscriptModalTokens(snippetTokens)}
                  </div>
                  <div className="modal-section">
                    <div className="panel-title">
                      <h3>Multi-Clip Segments</h3>
                      {spans.length > 0 ? (
                        <button
                          className="button button-secondary"
                          type="button"
                          onClick={() => void updateCandidateSpans(candidate, [])}
                        >
                          Reset
                        </button>
                      ) : null}
                    </div>
                    <div className="badge-row">
                      {spans.length === 0 ? (
                        <span className="pill mono">continuous range</span>
                      ) : spans.map((span, index) => (
                        <button
                          key={`${span.sourceStartMs}-${span.sourceEndMs}`}
                          className="pill mono pill-button"
                          type="button"
                          onClick={() => removeCandidateSpan(candidate, index)}
                        >
                          {index + 1}. {formatDuration(span.sourceStartMs)} - {formatDuration(span.sourceEndMs)} ×
                        </button>
                      ))}
                    </div>
                    <div className="transcript-rows transcript-rows-compact">
                      {snippetGroups.map((group) => (
                        <div className="transcript-row" key={`segment-${group.id}`}>
                          <button
                            className="range-stepper"
                            type="button"
                            onClick={() => addCandidateSpan(candidate, group)}
                            aria-label="Add transcript group as a multi-clip segment"
                          >
                            +
                          </button>
                          <div className="transcript-time mono">
                            {formatDuration(group.startMs)} - {formatDuration(group.endMs)}
                          </div>
                          {renderTranscriptModalTokens(group.tokens)}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      ) : null}
      {subtitleEditor ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={closeSubtitleEditor}
        >
          <div className="modal-panel subtitle-editor-modal" onClick={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2>Subtitle editor</h2>
              <div className="button-row">
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={subtitleEditor.saving || subtitleEditor.loading || subtitleEditor.rerendering}
                  onClick={() => void resetSubtitleCues()}
                >
                  Reset
                </button>
                <button
                  className="button button-primary"
                  type="button"
                  disabled={!subtitleEditor.dirty || subtitleEditor.saving || subtitleEditor.loading || subtitleEditor.rerendering}
                  onClick={() => void saveSubtitleCues()}
                >
                  {subtitleEditor.saving ? "Saving" : "Save"}
                </button>
                <button
                  className="button button-primary"
                  type="button"
                  disabled={subtitleEditor.loading || subtitleEditor.saving || subtitleEditor.rerendering}
                  onClick={() => void rerenderEditedSubtitles()}
                >
                  {subtitleEditor.rerendering ? "Queueing" : "Re-render"}
                </button>
                <button className="button button-secondary" type="button" onClick={closeSubtitleEditor}>
                  Close
                </button>
              </div>
            </div>
            {subtitleEditor.loading ? (
              <div className="empty">Loading subtitle cues…</div>
            ) : (
              <div className="subtitle-editor-grid">
                <div className="subtitle-video-panel">
                  <video
                    ref={subtitleVideoRef}
                    className="subtitle-editor-video"
                    src={`/api/exports/${subtitleEditor.renderId}/video`}
                    controls
                    playsInline
                    onTimeUpdate={(event) => setSubtitleCurrentMs(Math.round(event.currentTarget.currentTime * 1000))}
                    onSeeked={(event) => setSubtitleCurrentMs(Math.round(event.currentTarget.currentTime * 1000))}
                  />
                  <div className="badge-row">
                    <span className="pill mono">{formatCueTime(subtitleCurrentMs)}</span>
                    {subtitleEditor.dirty ? <span className="pill status-pending">unsaved</span> : <span className="pill status-rendered">saved</span>}
                  </div>
                </div>
                <div className="subtitle-cue-list">
                  {subtitleEditor.cues.length === 0 ? (
                    <div className="empty">No subtitle cues found for this render.</div>
                  ) : null}
                  {subtitleEditor.cues.map((cue, index) => {
                    const isActive = subtitleCurrentMs >= cue.startMs && subtitleCurrentMs <= cue.endMs;
                    return (
                      <div className={`subtitle-cue-row ${isActive ? "subtitle-cue-row-active" : ""}`} key={cue.id}>
                        <button className="range-stepper" type="button" onClick={() => seekSubtitleCue(cue)}>
                          ▶
                        </button>
                        <div className="subtitle-cue-time">
                          <span className="mono">{formatCueTime(cue.startMs)}</span>
                          <span className="mono">{formatCueTime(cue.endMs)}</span>
                        </div>
                        <textarea
                          className="subtitle-cue-text"
                          value={cue.text}
                          rows={2}
                          onChange={(event) =>
                            patchSubtitleCues((cues) =>
                              cues.map((item) =>
                                item.id === cue.id ? { ...item, text: event.target.value, editSource: "user" as const } : item,
                              ),
                            )
                          }
                        />
                        <div className="subtitle-cue-controls">
                          <button className="range-stepper" type="button" onClick={() => nudgeSubtitleCue(cue.id, "start", -100)}>
                            S-
                          </button>
                          <button className="range-stepper" type="button" onClick={() => nudgeSubtitleCue(cue.id, "start", 100)}>
                            S+
                          </button>
                          <button className="range-stepper" type="button" onClick={() => nudgeSubtitleCue(cue.id, "end", -100)}>
                            E-
                          </button>
                          <button className="range-stepper" type="button" onClick={() => nudgeSubtitleCue(cue.id, "end", 100)}>
                            E+
                          </button>
                          <button className="button button-secondary" type="button" onClick={() => splitSubtitleCue(cue)}>
                            Split
                          </button>
                          <button
                            className="button button-secondary"
                            type="button"
                            disabled={index >= subtitleEditor.cues.length - 1}
                            onClick={() => mergeSubtitleCueWithNext(cue)}
                          >
                            Merge
                          </button>
                          <button
                            className="button button-secondary"
                            type="button"
                            onClick={() =>
                              patchSubtitleCues((cues) =>
                                cues.map((item) =>
                                  item.id === cue.id ? { ...item, isHidden: !item.isHidden, editSource: "user" as const } : item,
                                ),
                              )
                            }
                          >
                            {cue.isHidden ? "Show" : "Hide"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
      {approvalModal ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setApprovalModal(null)}
        >
          <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2>Approve clip</h2>
              <button className="button button-secondary" type="button" onClick={() => setApprovalModal(null)}>
                Close
              </button>
            </div>
            {(() => {
              const candidate = detail.candidates.find((item) => item.id === approvalModal.candidateId);
              const selectedTemplate = templates.find((template) => template.id === approvalModal.templateId) ?? null;

              return (
            <div className="modal-content">
              <div className="approval-preview-shell">
                <div className="modal-section">
                  <span className="field-label">Clip</span>
                  <strong>{candidate?.title ?? "Selected clip"}</strong>
                  <p className="run-url">{candidate?.hook ?? "Render this moment with custom finishing settings."}</p>
                  {candidate ? (
                    <span className="pill mono">
                      {formatDuration(candidate.suggestedStartMs)} - {formatDuration(candidate.suggestedEndMs)} ({formatDuration(candidate.suggestedEndMs - candidate.suggestedStartMs)})
                    </span>
                  ) : null}
                </div>
                <div className="modal-section">
                  <span className="field-label">Choose Template</span>
                  <select
                    className="select-input"
                    value={approvalModal.templateId}
                    onChange={(event) =>
                      setApprovalModal((current) =>
                        current ? { ...current, templateId: event.target.value } : current
                      )
                    }
                  >
                    <option value="">Choose a template</option>
                    <option value="__new__">New template…</option>
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                  {approvalModal.templateId === "__new__" ? (
                    <Link className="button button-secondary" href="/templates">
                      Create template
                    </Link>
                  ) : null}
                  <label className="field-label" htmlFor="approval-intro">
                    Clip Intro
                  </label>
                  <input
                    id="approval-intro"
                    className="file-input"
                    type="file"
                    accept="image/*,video/*"
                    onChange={(event) => void handleIntroUpload("approval", event.target.files?.[0] ?? null)}
                  />
                  <p className="field-hint">Current asset: {approvalModal.introLabel}</p>
                  {introUploadScope === "approval" ? (
                    <p className="field-hint">Uploading intro…</p>
                  ) : null}
                </div>
                <div className="modal-section approval-caption-preview">
                  <span className="field-label">Template Preview</span>
                  {selectedTemplate ? (
                    <>
                      <div
                        className={`approval-caption-chip approval-caption-${selectedTemplate.captionStyle} approval-caption-size-${selectedTemplate.captionSize}`}
                        style={{ color: selectedTemplate.captionColor }}
                      >
                        Decisions compound fast
                      </div>
                      <div className="approval-asset-list">
                        <div><strong>Layout</strong><span>{selectedTemplate.videoLayout}</span></div>
                        <div><strong>Frame Fit</strong><span>{selectedTemplate.videoFillMode}</span></div>
                        <div><strong>Placement</strong><span>{selectedTemplate.captionPlacement}</span></div>
                        <div><strong>Music Volume</strong><span>{selectedTemplate.musicVolume}%</span></div>
                        <div><strong>Fade</strong><span>{selectedTemplate.musicFadeIn ? "In" : "No in"} / {selectedTemplate.musicFadeOut ? "Out" : "No out"}</span></div>
                        <div><strong>Clip Intro</strong><span>{approvalModal.introSrc || selectedTemplate.introSrc ? "Attached" : "None"}</span></div>
                        <div><strong>Music</strong><span>{selectedTemplate.musicSrc ? "Attached" : "None"}</span></div>
                        <div><strong>Outro</strong><span>{selectedTemplate.outroSrc ? "Attached" : "None"}</span></div>
                      </div>
                    </>
                  ) : (
                    <p className="muted">Pick a template to preview the final caption and layout settings.</p>
                  )}
                </div>
              </div>
              <div className="button-row">
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={!approvalModal.templateId || approvalModal.templateId === "__new__" || introUploadScope === "approval"}
                    onClick={() => void approveCandidate(approvalModal.candidateId, approvalModal.templateId)}
                  >
                    Approve Clip
                  </button>
                </div>
            </div>
              );
            })()}
          </div>
        </div>
      ) : null}
    </div>
  );
}
