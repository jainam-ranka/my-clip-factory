import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_POLL_INTERVAL_MS,
} from "@/lib/config";
import type { ClipCandidate, IngestionRun, RenderConfig, RenderJob } from "@/lib/types";
import {
  createRun,
  getCandidate,
  getRunDetail,
  listExportsForRun,
  listRuns,
  listTelegramNotificationReadyExports,
  listRenderTemplates,
  markRenderTelegramNotified,
  setCandidateRenderConfig,
  setCandidateStatus,
} from "./repository";
import { prepareApprovedCandidateForRender, queueCandidateForRenderWithFormats } from "./runtime";
import { bootstrapServer } from "./bootstrap";

type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: {
    id: number;
  };
};

type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: TelegramMessage;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type InlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
};

const MAX_MESSAGE_LENGTH = 3900;
const MAX_RUNS = 10;
const MAX_CLIPS_PER_RUN = 12;
type RunSelectionMode = "pending" | "all";

function getBotToken() {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }

  return TELEGRAM_BOT_TOKEN;
}

async function telegramApi<T>(method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${getBotToken()}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
  if (!response.ok || !body?.ok) {
    throw new Error(body?.description ?? `Telegram ${method} failed.`);
  }

  return body.result as T;
}

function chunkMessage(text: string) {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
    chunks.push(text.slice(index, index + MAX_MESSAGE_LENGTH));
  }
  return chunks;
}

async function sendMessage(chatId: number | string, text: string, replyMarkup?: InlineKeyboard) {
  for (const chunk of chunkMessage(text)) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: false,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

function getAuthorizedChatId(messageChatId?: number) {
  if (TELEGRAM_CHAT_ID) {
    return TELEGRAM_CHAT_ID;
  }

  return messageChatId;
}

function parseStartRun(text: string) {
  const match = text.match(/^\/start_run\s+(\S+)(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  return {
    url: match[1],
    label: match[2]?.trim() || undefined,
  };
}

async function handleStartRun(chatId: number | string, text: string) {
  const input = parseStartRun(text);
  if (!input) {
    await sendMessage(chatId, "Usage: /start_run <youtube-or-x-url> [label]");
    return;
  }

  const detail = createRun(input);
  if (!detail) {
    await sendMessage(chatId, "Could not start the run.");
    return;
  }

  await sendMessage(chatId, `Started run:\n${detail.run.label}\n${detail.run.id}`);
}

async function handleRuns(chatId: number | string) {
  const runs = listRuns().slice(0, MAX_RUNS);
  if (runs.length === 0) {
    await sendMessage(chatId, "No runs yet.");
    return;
  }

  await sendMessage(
    chatId,
    [
      "Recent runs:",
      "",
      runs.map((run, index) => formatRunSummary(run, index + 1)).join("\n\n"),
      "",
      "Reply with a run number to open all clips for that run.",
      "Use /clips <run-number> for pending clips only.",
    ].join("\n"),
    {
      inline_keyboard: runs.map((run, index) => [
        { text: `${index + 1}. Pending`, callback_data: `runpending:${run.id}` },
        { text: `${index + 1}. All`, callback_data: `runall:${run.id}` },
      ]),
    },
  );
}

function formatRunSummary(run: IngestionRun, index: number) {
  const detail = getRunDetail(run.id);
  const exports = listExportsForRun(run.id);
  const pending = detail?.candidates.filter((candidate) => candidate.status === "pending").length ?? 0;
  const approved = detail?.candidates.filter((candidate) => candidate.status === "approved").length ?? 0;
  const rendered = exports.filter((item) => item.status === "rendered").length;
  const driveUploads = exports.filter((item) => item.driveWebViewLink).length;

  return [
    `${index}. ${run.label}`,
    `Status: ${run.status} | Pending: ${pending} | Approved: ${approved} | Rendered: ${rendered} | Drive uploaded: ${driveUploads}`,
    `Source: ${run.sourceUrl}`,
    run.driveFolderId
      ? `Drive folder: https://drive.google.com/drive/folders/${run.driveFolderId}`
      : "Drive folder: not created yet",
  ].join("\n");
}

async function handleClips(chatId: number | string, text: string) {
  const match = text.match(/^\/clips(?:\s+(\d+|run_[a-z0-9]+))?$/i);
  const selector = match?.[1];

  if (!selector) {
    await handleRuns(chatId);
    await sendMessage(chatId, "Choose a run above, or use /clips <run-number> for pending clips only.");
    return;
  }

  await handleRunSelection(chatId, selector, "pending");
}

async function handleRunSelection(chatId: number | string, selector: string, mode: RunSelectionMode) {
  const run = getRecentRun(selector);

  if (!run) {
    await sendMessage(chatId, "Run not found in the recent run list. Use /runs first.");
    return;
  }

  await sendRunClips(chatId, run.id, mode);
}

function getRecentRuns() {
  return listRuns().slice(0, MAX_RUNS);
}

function getRecentRun(selector: string) {
  const runs = getRecentRuns();
  return selector.startsWith("run_")
    ? runs.find((item) => item.id === selector)
    : runs[Number(selector) - 1];
}

async function sendRunClips(chatId: number | string, runId: string, mode: RunSelectionMode) {
  const detail = getRunDetail(runId);
  if (!detail) {
    await sendMessage(chatId, "Run not found.");
    return;
  }

  const exports = listExportsForRun(runId);
  const visibleCandidates = (mode === "pending"
    ? detail.candidates.filter((candidate) => candidate.status === "pending")
    : detail.candidates)
    .slice(0, MAX_CLIPS_PER_RUN);

  if (visibleCandidates.length === 0) {
    await sendMessage(
      chatId,
      mode === "pending"
        ? `No pending clips for ${detail.run.label} yet.`
        : `No clips for ${detail.run.label} yet.`,
    );
    return;
  }

  await sendMessage(
    chatId,
    mode === "pending"
      ? `Pending clips for ${detail.run.label}`
      : `All clips for ${detail.run.label}`,
  );

  for (const [index, candidate] of visibleCandidates.entries()) {
    await sendClipCard(chatId, detail.run.label, candidate, exports, index + 1);
  }
}

function getCandidateExports(
  candidateId: string,
  exports: Array<RenderJob & { title: string; hook: string; fileName: string | null }>,
) {
  return exports.filter((item) => item.candidateId === candidateId);
}

async function sendClipCard(
  chatId: number | string,
  runLabel: string,
  candidate: ClipCandidate,
  exports: Array<RenderJob & { title: string; hook: string; fileName: string | null }>,
  index: number,
) {
  const candidateExports = getCandidateExports(candidate.id, exports);
  const renderedExports = candidateExports.filter((item) => item.status === "rendered");
  const driveLinks = renderedExports.filter((item) => item.driveWebViewLink);
  const renderStatuses = candidateExports.length
    ? candidateExports.map((item) => `${item.format}: ${item.status}/${item.driveUploadStatus}`).join(", ")
    : "not queued";
  const isRendered = renderedExports.length > 0;
  const keyboard: InlineKeyboard = {
    inline_keyboard: [
      ...(isRendered
        ? []
        : [[
            { text: "Approve", callback_data: `approve:${candidate.id}` },
            { text: "Reject", callback_data: `reject:${candidate.id}` },
          ]]),
      ...driveLinks.map((item) => [{ text: `Open ${item.format} Drive`, url: item.driveWebViewLink ?? undefined }]),
    ],
  };

  await sendMessage(
    chatId,
    [
      `${index}. ${candidate.title}`,
      `Run: ${runLabel}`,
      `Status: ${candidate.status}`,
      `Confidence: ${Math.round(candidate.confidence * 100)}%`,
      `Renders: ${renderStatuses}`,
      candidate.hook,
      "",
      candidate.reason,
    ].join("\n"),
    keyboard,
  );
}

function buildDefaultRenderConfig(): RenderConfig {
  return {
    templateId: null,
    templateName: "Telegram default",
    mode: "edited",
    aiMotionEnabled: true,
    motionIntensity: "subtle",
    allowPunchIns: true,
    maxMotionEvents: 4,
    enableCaptions: true,
    enableMotion: true,
    enableColor: true,
    enableMusic: false,
    enableCompaction: true,
    colorGradePreset: "neutral",
    aiMusicEnabled: false,
    introSrc: null,
    outroSrc: null,
    musicSrc: null,
    musicPreset: "balanced",
    musicVolume: null,
    musicFadeIn: true,
    musicFadeOut: true,
    captionStyle: "pill",
    captionSize: "md",
    captionColor: null,
    captionPlacement: "bottom",
    outputFileName: null,
    videoLayout: null,
    videoFillMode: "blur",
    fontFamily: null,
    fontSource: null,
    subtitleMode: "phrase_1_4",
  };
}

async function sendTemplateChoices(chatId: number | string, candidateId: string) {
  const candidate = getCandidate(candidateId);
  if (!candidate) {
    throw new Error("Candidate not found.");
  }

  const templates = listRenderTemplates().slice(0, 8);
  await sendMessage(
    chatId,
    `Choose a template for:\n${candidate.title}`,
    {
      inline_keyboard: [
        [{ text: "Default", callback_data: `tpl:${candidateId}:default` }],
        ...templates.map((template) => [
          { text: template.name, callback_data: `tpl:${candidateId}:${template.id}` },
        ]),
      ],
    },
  );
}

async function approveCandidateFromTelegram(candidateId: string, templateId: string | null) {
  const candidate = getCandidate(candidateId);
  if (!candidate) {
    throw new Error("Candidate not found.");
  }

  const template = templateId && templateId !== "default"
    ? listRenderTemplates().find((item) => item.id === templateId)
    : null;

  if (templateId && templateId !== "default" && !template) {
    throw new Error("Template not found.");
  }

  setCandidateRenderConfig(
    candidateId,
    template
      ? {
          templateId: template.id,
          templateName: template.name,
          mode: template.mode,
          aiMotionEnabled: template.mode === "raw" ? false : template.aiMotionEnabled,
          motionIntensity: template.mode === "raw" ? "none" : template.motionIntensity,
          allowPunchIns: template.mode === "raw" ? false : template.allowPunchIns,
          maxMotionEvents: template.mode === "raw" ? 0 : template.maxMotionEvents,
          enableCaptions: template.mode === "raw" ? false : template.enableCaptions,
          enableMotion: template.mode === "raw" ? false : template.enableMotion,
          enableColor: template.mode === "raw" ? false : template.enableColor,
          enableMusic: template.mode === "raw" ? false : template.enableMusic,
          enableCompaction: template.mode === "raw" ? false : template.enableCompaction,
          colorGradePreset: template.colorGradePreset,
          aiMusicEnabled: template.mode === "raw" ? false : template.aiMusicEnabled,
          introSrc: template.introSrc,
          outroSrc: template.outroSrc,
          musicSrc: template.mode === "raw" ? null : template.musicSrc,
          musicPreset: "balanced",
          musicVolume: template.musicVolume,
          musicFadeIn: template.musicFadeIn,
          musicFadeOut: template.musicFadeOut,
          captionStyle: template.captionStyle,
          captionSize: template.captionSize,
          captionColor: template.captionColor,
          captionPlacement: template.captionPlacement,
          fontFamily: template.fontFamily,
          fontSource: template.fontSource,
          subtitleMode: template.subtitleMode,
          outputFileName: null,
          videoLayout: template.videoLayout,
          videoFillMode: template.videoFillMode,
        }
      : buildDefaultRenderConfig(),
  );
  setCandidateStatus(candidateId, "approved");
  await prepareApprovedCandidateForRender(candidateId);

  const hydrated = getCandidate(candidateId) ?? candidate;
  const renderJobs = queueCandidateForRenderWithFormats(
    candidateId,
    [hydrated.renderConfig?.videoLayout ?? "vertical"],
  ).filter(
    (job): job is RenderJob => Boolean(job),
  );
  return {
    candidate: hydrated,
    templateName: template?.name ?? "Default",
    renderJobs,
  };
}

async function handleCallback(query: TelegramCallbackQuery) {
  const chatId = query.message?.chat.id;
  if (!chatId || !query.data) {
    return;
  }

  const authorizedChatId = getAuthorizedChatId(chatId);
  if (String(authorizedChatId) !== String(chatId)) {
    await answerCallbackQuery(query.id, "Unauthorized chat.");
    return;
  }

  const [action, id] = query.data.split(":");
  if (!id) {
    return;
  }

  if (action === "runclips") {
    await answerCallbackQuery(query.id, "Loading clips.");
    await sendRunClips(chatId, id, "all");
    return;
  }

  if (action === "runpending") {
    await answerCallbackQuery(query.id, "Loading pending clips.");
    await sendRunClips(chatId, id, "pending");
    return;
  }

  if (action === "runall") {
    await answerCallbackQuery(query.id, "Loading clips.");
    await sendRunClips(chatId, id, "all");
    return;
  }

  if (action === "approve") {
    try {
      await sendTemplateChoices(chatId, id);
      await answerCallbackQuery(query.id, "Choose a template.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Approval failed.";
      await answerCallbackQuery(query.id, message);
      await sendMessage(chatId, message);
    }
    return;
  }

  if (action === "tpl") {
    const templateId = query.data.split(":")[2] ?? "default";
    try {
      const result = await approveCandidateFromTelegram(id, templateId);
      const runLabel = getRunDetail(result.candidate.runId)?.run.label ?? "Unknown run";
      await answerCallbackQuery(query.id, "Approved.");
      await sendMessage(
        chatId,
        [
          "Approved:",
          result.candidate.title,
          `Run: ${runLabel}`,
          `Template: ${result.templateName}`,
          `Queued: ${result.renderJobs.map((job) => job.format).join(", ")}`,
        ].join("\n"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Approval failed.";
      await answerCallbackQuery(query.id, message);
      await sendMessage(chatId, message);
    }
    return;
  }

  if (action === "reject") {
    const candidate = getCandidate(id);
    setCandidateStatus(id, "rejected");
    await answerCallbackQuery(query.id, "Rejected.");
    await sendMessage(
      chatId,
      candidate
        ? `Rejected:\n${candidate.title}\nRun: ${getRunDetail(candidate.runId)?.run.label ?? "Unknown run"}`
        : `Rejected clip ${id}.`,
    );
  }
}

async function handleMessage(message: TelegramMessage) {
  const chatId = getAuthorizedChatId(message.chat.id);
  if (!chatId) {
    return;
  }

  if (String(chatId) !== String(message.chat.id)) {
    await sendMessage(message.chat.id, "This chat is not authorized for this bot.");
    return;
  }

  const text = message.text?.trim() ?? "";
  if (text.startsWith("/start_run")) {
    await handleStartRun(chatId, text);
    return;
  }

  if (text === "/runs") {
    await handleRuns(chatId);
    return;
  }

  if (text.startsWith("/clips")) {
    await handleClips(chatId, text);
    return;
  }

  if (/^\d+$/.test(text)) {
    const run = getRecentRun(text);
    if (run) {
      await sendRunClips(chatId, run.id, "all");
      return;
    }
  }

  if (text === "/chat_id") {
    await sendMessage(chatId, `Chat ID: ${message.chat.id}`);
    return;
  }

  await sendMessage(
    chatId,
    [
      "Commands:",
      "/start_run <url> [label]",
      "/runs",
      "/clips <run-number>",
      "Reply with a run number after /runs to open all clips.",
      "/chat_id",
    ].join("\n"),
  );
}

async function sendReadyExportNotifications(chatId: number | string) {
  const exports = listTelegramNotificationReadyExports();
  for (const item of exports) {
    await sendMessage(
      chatId,
      [
        `Rendered: ${item.title}`,
        `Format: ${item.format}`,
        item.hook,
        "",
        `Drive: ${item.driveWebViewLink}`,
      ].join("\n"),
    );
    markRenderTelegramNotified(item.id);
  }
}

async function pollUpdates(offset: number | null) {
  return telegramApi<TelegramUpdate[]>("getUpdates", {
    timeout: 25,
    allowed_updates: ["message", "callback_query"],
    ...(offset ? { offset } : {}),
  });
}

export async function runTelegramBot() {
  bootstrapServer();
  let offset: number | null = null;
  let discoveredChatId: number | null = TELEGRAM_CHAT_ID ? Number(TELEGRAM_CHAT_ID) : null;

  await telegramApi("deleteWebhook", { drop_pending_updates: false });
  console.log("Telegram bot polling started.");

  for (;;) {
    try {
      const updates = await pollUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          discoveredChatId = update.message.chat.id;
          await handleMessage(update.message);
        }

        if (update.callback_query) {
          await handleCallback(update.callback_query);
        }
      }

      const notifyChatId = TELEGRAM_CHAT_ID ?? discoveredChatId;
      if (notifyChatId) {
        await sendReadyExportNotifications(notifyChatId);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, TELEGRAM_POLL_INTERVAL_MS));
    }
  }
}
