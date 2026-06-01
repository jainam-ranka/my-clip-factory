import type { CaptionToken, RenderSubtitleCue, SubtitleMode, TranscriptToken } from "@/lib/types";

const PUNCTUATION_BREAK = /[.,!?;:]$/;
const PAUSE_GAP_MS = 400;
const PHRASE_MAX_WORDS = 4;
const PHRASE_HARD_GAP_MS = 500;
const PHRASE_MIN_READ_MS = 1100;
const PHRASE_WORD_READ_MS = 260;
const PHRASE_GROUP_GAP_MS = 80;
const CLAUSE_START_WORDS = new Set(["i", "so", "that", "we", "you"]);

export type CaptionTokenWithSource = CaptionToken & {
  id?: string;
  sourceTokenIds?: string[];
  isRemoved?: boolean;
};

type CaptionGroup<T extends CaptionTokenWithSource> = T[];

function isClauseStartWord(text: string) {
  return CLAUSE_START_WORDS.has(text.toLowerCase());
}

function isPhraseContinuation(previous: CaptionTokenWithSource, next: CaptionTokenWithSource) {
  const pair = `${previous.text.toLowerCase()} ${next.text.toLowerCase()}`;
  return pair === "go public" || pair === "in nasdaq" || pair === "stable coins";
}

function shouldHardBreak(previous: CaptionTokenWithSource, next: CaptionTokenWithSource) {
  return (next.startMs - previous.endMs > PHRASE_HARD_GAP_MS && !isPhraseContinuation(previous, next)) ||
    PUNCTUATION_BREAK.test(previous.text);
}

function shouldClauseBreak<T extends CaptionTokenWithSource>(group: CaptionGroup<T>, next: T) {
  if (group.length < 2) {
    return false;
  }

  const previous = group[group.length - 1];
  const gapMs = next.startMs - previous.endMs;
  return gapMs >= 0 && isClauseStartWord(next.text);
}

function splitClauseIntoPhrases<T extends CaptionTokenWithSource>(clause: CaptionGroup<T>): Array<CaptionGroup<T>> {
  if (clause.length <= PHRASE_MAX_WORDS) {
    return [clause];
  }

  const phraseCount = Math.ceil(clause.length / PHRASE_MAX_WORDS);
  const baseSize = Math.floor(clause.length / phraseCount);
  let remainder = clause.length % phraseCount;
  const groups: Array<CaptionGroup<T>> = [];
  let cursor = 0;

  for (let index = 0; index < phraseCount; index += 1) {
    const size = baseSize + (phraseCount === 2 ? (index < remainder ? 1 : 0) : (index >= phraseCount - remainder ? 1 : 0));
    groups.push(clause.slice(cursor, cursor + size));
    cursor += size;
  }

  return groups;
}

export function buildCaptionGroups<T extends CaptionTokenWithSource>(
  captions: T[],
  subtitleMode: SubtitleMode,
): Array<CaptionGroup<T>> {
  if (subtitleMode !== "phrase_1_4") {
    return captions.map((caption) => [caption]);
  }

  const clauses: Array<CaptionGroup<T>> = [];
  let current: CaptionGroup<T> = [];

  for (const token of captions) {
    if (
      current.length > 0 &&
      (shouldHardBreak(current[current.length - 1], token) || shouldClauseBreak(current, token))
    ) {
      clauses.push(current);
      current = [];
    }

    current.push(token);
  }

  if (current.length > 0) {
    clauses.push(current);
  }

  return clauses.flatMap(splitClauseIntoPhrases);
}

export function buildTimedCaptionCues<T extends CaptionTokenWithSource>(
  captions: T[],
  subtitleMode: SubtitleMode,
): Array<RenderSubtitleCue & { sourceTokenIds: string[] }> {
  const groups = buildCaptionGroups(captions, subtitleMode);

  return groups.map((group, index) => {
    const naturalStartMs = group[0].startMs;
    const naturalEndMs = group[group.length - 1].endMs;
    const sourceTokenIds = group.flatMap((token) => token.sourceTokenIds ?? (token.id ? [token.id] : []));
    if (subtitleMode !== "phrase_1_4") {
      return {
        text: group.map((token) => token.text).join(" "),
        startMs: naturalStartMs,
        endMs: naturalEndMs,
        sourceTokenIds,
      };
    }

    const nextStartMs = groups[index + 1]?.[0]?.startMs ?? Number.POSITIVE_INFINITY;
    const readableEndMs = naturalStartMs + Math.max(PHRASE_MIN_READ_MS, group.length * PHRASE_WORD_READ_MS);
    const extendedEndMs = Math.max(naturalEndMs, readableEndMs);
    const cappedEndMs = Number.isFinite(nextStartMs)
      ? Math.min(extendedEndMs, nextStartMs - PHRASE_GROUP_GAP_MS)
      : extendedEndMs;

    return {
      text: group.map((token) => token.text).join(" "),
      startMs: naturalStartMs,
      endMs: Math.max(naturalEndMs, cappedEndMs),
      sourceTokenIds,
    };
  });
}

export function transcriptTokensToCaptionTokens(tokens: TranscriptToken[]): CaptionTokenWithSource[] {
  return tokens
    .filter((token) => !token.isRemoved && token.text.trim())
    .map((token) => ({
      id: token.id,
      sourceTokenIds: [token.id],
      text: token.text,
      startMs: token.startMs,
      endMs: token.endMs,
    }));
}
