import { useMemo } from "react";
import {
  Audio,
  AbsoluteFill,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  Series,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { ClipRenderProps } from "@/lib/types";

const ARCHIVO_FONT_FACE = `
@font-face {
  font-family: "Archivo";
  src: url("${staticFile("fonts/Archivo-latin.woff2")}") format("woff2");
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}`;
const SYSTEM_FONT_STACK = "Archivo, Arial, Helvetica, sans-serif";

function resolveFontFamily(fontFamily?: string | null) {
  return fontFamily?.trim() || SYSTEM_FONT_STACK;
}

function isImageAsset(src: string | null) {
  return Boolean(src?.match(/\.(avif|gif|jpe?g|png|webp)$/i));
}

const PUNCTUATION_BREAK = /[.,!?;:]$/;
const PAUSE_GAP_MS = 400;
const ONE_WORD_GROUP_SIZE = 1;
const PHRASE_MAX_WORDS = 4;
const PHRASE_HARD_GAP_MS = 500;
const PHRASE_MIN_READ_MS = 1100;
const PHRASE_WORD_READ_MS = 260;
const PHRASE_GROUP_GAP_MS = 80;
const CLAUSE_START_WORDS = new Set(["i", "so", "that", "we", "you"]);
const CAPTION_SIDE_PADDING = "7.5%";
const CAPTION_BOTTOM = 128;
const CAPTION_LINE_HEIGHT = 1.18;
const CAPTION_WORD_GAP = "0.54em";
const CAPTION_ROW_GAP = "0.54em";
const INTRO_TRANSITION_FRAMES = 18;
const HUD_DURATION_FRAMES = 96;

type CaptionToken = ClipRenderProps["captions"][number];
type CaptionGroup = CaptionToken[];
type TimedCaptionGroup = {
  tokens: CaptionGroup;
  startMs: number;
  endMs: number;
};

function isClauseStartWord(text: string) {
  return CLAUSE_START_WORDS.has(text.toLowerCase());
}

function buildOneWordCaptionGroups(captions: CaptionToken[]): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  let current: CaptionGroup = [];

  for (let index = 0; index < captions.length; index += 1) {
    current.push(captions[index]);

    const isPunctuationBreak = PUNCTUATION_BREAK.test(captions[index].text);
    const isMaxSize = current.length >= ONE_WORD_GROUP_SIZE;
    const isPauseBreak =
      index < captions.length - 1 &&
      captions[index + 1].startMs - captions[index].endMs > PAUSE_GAP_MS;

    if (isPunctuationBreak || isMaxSize || isPauseBreak) {
      groups.push(current);
      current = [];
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function isPhraseContinuation(previous: CaptionToken, next: CaptionToken) {
  const pair = `${previous.text.toLowerCase()} ${next.text.toLowerCase()}`;
  return pair === "go public" || pair === "in nasdaq" || pair === "stable coins";
}

function shouldHardBreak(previous: CaptionToken, next: CaptionToken) {
  return (next.startMs - previous.endMs > PHRASE_HARD_GAP_MS && !isPhraseContinuation(previous, next)) ||
    PUNCTUATION_BREAK.test(previous.text);
}

function shouldClauseBreak(group: CaptionGroup, next: CaptionToken) {
  if (group.length < 2) {
    return false;
  }

  const previous = group[group.length - 1];
  const gapMs = next.startMs - previous.endMs;
  return gapMs >= 0 && isClauseStartWord(next.text);
}

function splitClauseIntoPhrases(clause: CaptionGroup): CaptionGroup[] {
  if (clause.length <= PHRASE_MAX_WORDS) {
    return [clause];
  }

  const phraseCount = Math.ceil(clause.length / PHRASE_MAX_WORDS);
  const baseSize = Math.floor(clause.length / phraseCount);
  let remainder = clause.length % phraseCount;
  const groups: CaptionGroup[] = [];
  let cursor = 0;

  for (let index = 0; index < phraseCount; index += 1) {
    const size = baseSize + (phraseCount === 2 ? (index < remainder ? 1 : 0) : (index >= phraseCount - remainder ? 1 : 0));
    groups.push(clause.slice(cursor, cursor + size));
    cursor += size;
  }

  return groups;
}

function buildPhraseCaptionGroups(captions: CaptionToken[]): CaptionGroup[] {
  const clauses: CaptionGroup[] = [];
  let current: CaptionGroup = [];

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

function buildCaptionGroups(captions: CaptionToken[], subtitleMode: ClipRenderProps["subtitleMode"]): CaptionGroup[] {
  if (subtitleMode === "phrase_1_4") {
    return buildPhraseCaptionGroups(captions);
  }

  return buildOneWordCaptionGroups(captions);
}

function buildTimedCaptionGroups(
  groups: CaptionGroup[],
  subtitleMode: ClipRenderProps["subtitleMode"],
): TimedCaptionGroup[] {
  return groups.map((group, index) => {
    const naturalStartMs = group[0].startMs;
    const naturalEndMs = group[group.length - 1].endMs;
    if (subtitleMode !== "phrase_1_4") {
      return { tokens: group, startMs: naturalStartMs, endMs: naturalEndMs };
    }

    const nextStartMs = groups[index + 1]?.[0]?.startMs ?? Number.POSITIVE_INFINITY;
    const readableEndMs = naturalStartMs + Math.max(PHRASE_MIN_READ_MS, group.length * PHRASE_WORD_READ_MS);
    const extendedEndMs = Math.max(naturalEndMs, readableEndMs);
    const cappedEndMs = Number.isFinite(nextStartMs)
      ? Math.min(extendedEndMs, nextStartMs - PHRASE_GROUP_GAP_MS)
      : extendedEndMs;

    return {
      tokens: group,
      startMs: naturalStartMs,
      endMs: Math.max(naturalEndMs, cappedEndMs),
    };
  });
}

function findActiveGroupIndex(groups: TimedCaptionGroup[], currentMs: number) {
  return groups.findIndex(
    (group) => currentMs >= group.startMs && currentMs <= group.endMs,
  );
}

function findActiveWordIndex(group: CaptionGroup, currentMs: number) {
  const directMatch = group.findIndex(
    (token) => currentMs >= token.startMs && currentMs <= token.endMs,
  );

  if (directMatch !== -1) {
    return directMatch;
  }

  for (let index = group.length - 1; index >= 0; index -= 1) {
    if (currentMs >= group[index].endMs) {
      return index;
    }
  }

  return 0;
}

function getCaptionPlacementStyle(
  captionPlacement: ClipRenderProps["captionPlacement"],
  format: ClipRenderProps["format"],
) {
  if (captionPlacement === "top") {
    return { top: format === "vertical" ? 168 : 96 };
  }

  if (captionPlacement === "middle") {
    return { top: "50%", transform: "translateY(-50%)" };
  }

  return { bottom: format === "vertical" ? CAPTION_BOTTOM : 72 };
}

function getCaptionWordStyle(input: {
  captionStyle: ClipRenderProps["captionStyle"];
  captionColor: string;
  fontSize: number;
  isActive: boolean;
  isPhraseMode: boolean;
  fontFamily: string;
}) {
  const isActive = input.isPhraseMode || input.isActive;
  const shared = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: input.fontSize,
    lineHeight: CAPTION_LINE_HEIGHT,
    letterSpacing: "-0.02em",
    whiteSpace: "pre",
  };

  if (input.captionStyle === "minimal") {
    return {
      ...shared,
      padding: "0",
      borderRadius: 0,
      fontFamily: input.fontFamily,
      fontWeight: isActive ? 800 : 600,
      color: isActive ? input.captionColor : "rgba(239, 247, 255, 0.84)",
      textShadow: isActive
        ? "0 0 20px rgba(244, 166, 11, 0.34), 0 3px 18px rgba(0,0,0,0.9)"
        : "0 3px 18px rgba(0,0,0,0.92)",
      transform: input.isPhraseMode ? "none" : `scale(${input.isActive ? 1.04 : 1})`,
    };
  }

  if (input.captionStyle === "mono") {
    return {
      ...shared,
      padding: "0.18em 0.42em",
      borderRadius: 14,
      fontFamily: input.fontFamily || "SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
      fontWeight: isActive ? 800 : 700,
      textTransform: "uppercase" as const,
      color: isActive ? "#041018" : "#d8fff5",
      background: isActive ? input.captionColor : "rgba(6, 19, 27, 0.82)",
      border: `1px solid ${isActive ? "rgba(255,255,255,0.16)" : "rgba(216,255,245,0.16)"}`,
      boxShadow: isActive
        ? "0 20px 34px rgba(0,0,0,0.38)"
        : "0 10px 24px rgba(0,0,0,0.28)",
      transform: input.isPhraseMode ? "none" : `translateY(${input.isActive ? "-2px" : "0px"})`,
    };
  }

  return {
    ...shared,
    padding: "0.18em 0.44em",
    borderRadius: 999,
    fontFamily: input.fontFamily,
    fontWeight: isActive ? 800 : 700,
    color: isActive ? "#041018" : "rgba(239, 247, 255, 0.9)",
    background: isActive ? input.captionColor : "rgba(6, 19, 27, 0.8)",
    border: `1px solid ${isActive ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)"}`,
    boxShadow: isActive
      ? "0 18px 34px rgba(0,0,0,0.34)"
      : "0 12px 28px rgba(0,0,0,0.24)",
    transform: input.isPhraseMode ? "none" : `translateY(${input.isActive ? "-2px" : "0px"})`,
  };
}

function WordCaptions({
  captions,
  subtitleCues,
  captionStyle,
  captionFontSize,
  captionColor,
  captionPlacement,
  format,
  fontFamily,
  subtitleMode,
  captionTimingOffsetMs,
}: Pick<
  ClipRenderProps,
  | "captions"
  | "subtitleCues"
  | "captionStyle"
  | "captionFontSize"
  | "captionColor"
  | "captionPlacement"
  | "format"
  | "fontFamily"
  | "subtitleMode"
  | "captionTimingOffsetMs"
>) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const clipRelativeMs = (frame / fps) * 1000;
  const autoCaptionMs = clipRelativeMs - captionTimingOffsetMs;

  if (subtitleCues && subtitleCues.length > 0) {
    const activeCue = subtitleCues.find(
      (cue) => !cue.isHidden && clipRelativeMs >= cue.startMs && clipRelativeMs <= cue.endMs,
    );
    if (!activeCue) {
      return null;
    }

    return (
      <div
        style={{
          position: "absolute",
          left: CAPTION_SIDE_PADDING,
          right: CAPTION_SIDE_PADDING,
          ...getCaptionPlacementStyle(captionPlacement, format),
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            maxWidth: format === "vertical" ? "88%" : "78%",
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: `${CAPTION_ROW_GAP} ${CAPTION_WORD_GAP}`,
          }}
        >
          {activeCue.text.split(/\s+/).filter(Boolean).map((word, index) => (
            <span
              key={`${activeCue.startMs}-${word}-${index}`}
              style={getCaptionWordStyle({
                captionStyle,
                captionColor,
                fontSize: captionFontSize,
                isActive: true,
                isPhraseMode: true,
                fontFamily: resolveFontFamily(fontFamily),
              })}
            >
              {word}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (captions.length === 0) {
    return null;
  }

  const groups = useMemo(
    () => buildTimedCaptionGroups(buildCaptionGroups(captions, subtitleMode), subtitleMode),
    [captions, subtitleMode],
  );
  const activeGroupIndex = findActiveGroupIndex(groups, autoCaptionMs);

  if (activeGroupIndex === -1) {
    return null;
  }

  const activeGroup = groups[activeGroupIndex].tokens;
  const activeWordIndex = findActiveWordIndex(activeGroup, autoCaptionMs);
  const isPhraseMode = subtitleMode === "phrase_1_4";

  return (
    <div
      style={{
        position: "absolute",
        left: CAPTION_SIDE_PADDING,
        right: CAPTION_SIDE_PADDING,
        ...getCaptionPlacementStyle(captionPlacement, format),
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          maxWidth: format === "vertical" ? "88%" : "78%",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: `${CAPTION_ROW_GAP} ${CAPTION_WORD_GAP}`,
        }}
      >
        {activeGroup.map((token, index) => {
          return (
            <span
              key={`${token.startMs}-${token.text}-${index}`}
              style={getCaptionWordStyle({
                captionStyle,
                captionColor,
                fontSize: captionFontSize,
                isActive: activeWordIndex === index,
                isPhraseMode,
                fontFamily: resolveFontFamily(fontFamily),
              })}
            >
              {token.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function DefaultIntroCard({
  title,
  hook,
  introFrames,
  fontFamily,
}: Pick<ClipRenderProps, "title" | "hook" | "introFrames" | "fontFamily">) {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, Math.max(0, introFrames - INTRO_TRANSITION_FRAMES), introFrames],
    [1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at top left, rgba(93, 228, 199, 0.24), transparent 32%), linear-gradient(180deg, #031018 0%, #08131b 58%, #091721 100%)",
        display: "grid",
        alignContent: "center",
        padding: "88px 92px",
        opacity,
      }}
    >
      <div style={{ maxWidth: "84%", display: "grid", gap: 20 }}>
        <div
          style={{
            display: "inline-flex",
            width: "fit-content",
            padding: "10px 16px",
            borderRadius: 999,
            background: "rgba(93, 228, 199, 0.14)",
            border: "1px solid rgba(93, 228, 199, 0.24)",
            color: "#d8fff5",
            fontFamily: resolveFontFamily(fontFamily),
            fontWeight: 700,
            fontSize: 20,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Clip Factory
        </div>
        <h1
          style={{
            margin: 0,
            color: "#f5f7fb",
            fontFamily: resolveFontFamily(fontFamily),
            fontWeight: 800,
            fontSize: 96,
            lineHeight: 0.92,
            letterSpacing: "-0.05em",
          }}
        >
          {title}
        </h1>
        <p
          style={{
            margin: 0,
            color: "rgba(245, 247, 251, 0.84)",
            fontFamily: resolveFontFamily(fontFamily),
            fontWeight: 600,
            fontSize: 34,
            lineHeight: 1.28,
            letterSpacing: "-0.015em",
          }}
        >
          {hook}
        </p>
      </div>
    </AbsoluteFill>
  );
}

function MusicBed({
  src,
  clipFrames,
  musicPreset,
  musicVolume,
  musicFadeInFrames,
  musicFadeOutFrames,
}: {
  src: string;
  clipFrames: number;
  musicPreset: ClipRenderProps["musicPreset"];
  musicVolume: number;
  musicFadeInFrames: number;
  musicFadeOutFrames: number;
}) {
  const frame = useCurrentFrame();
  const targetVolume =
    musicVolume > 0
      ? musicVolume / 100
      : musicPreset === "subtle"
        ? 0.03
        : musicPreset === "loud"
          ? 0.18
          : 0.09;

  const fadeIn =
    musicFadeInFrames > 0
      ? interpolate(frame, [0, musicFadeInFrames], [0, targetVolume], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : targetVolume;
  const fadeOut =
    musicFadeOutFrames > 0
      ? interpolate(
          frame,
          [Math.max(0, clipFrames - musicFadeOutFrames), clipFrames],
          [targetVolume, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        )
      : targetVolume;

  return <Audio src={src} volume={Math.min(fadeIn, fadeOut)} />;
}

function ClipHud({
  title,
  hook,
  format,
  clipFrame,
  fontFamily,
}: {
  title: string;
  hook: string;
  format: ClipRenderProps["format"];
  clipFrame: number;
  fontFamily: string;
}) {
  const opacity = interpolate(
    clipFrame,
    [0, 8, Math.max(24, HUD_DURATION_FRAMES - 18), HUD_DURATION_FRAMES],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const translateY = interpolate(
    clipFrame,
    [0, 10, HUD_DURATION_FRAMES],
    [18, 0, -10],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <div
      style={{
        position: "absolute",
        top: format === "vertical" ? 72 : 48,
        left: format === "vertical" ? 54 : 48,
        maxWidth: format === "vertical" ? "72%" : "46%",
        display: "grid",
        gap: 12,
        opacity,
        transform: `translateY(${translateY}px)`,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          width: "fit-content",
          padding: "9px 14px",
          borderRadius: 999,
          background: "rgba(7, 20, 30, 0.68)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          color: "#d8fff5",
          fontFamily: resolveFontFamily(fontFamily),
          fontWeight: 700,
          fontSize: 18,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          backdropFilter: "blur(18px)",
        }}
      >
        Clip
      </div>
      <div
        style={{
          display: "grid",
          gap: 8,
          padding: format === "vertical" ? "18px 18px 16px" : "16px 18px 16px",
          borderRadius: 26,
          background: "linear-gradient(180deg, rgba(5, 16, 25, 0.7), rgba(5, 16, 25, 0.46))",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          boxShadow: "0 24px 44px rgba(0,0,0,0.26)",
          backdropFilter: "blur(20px)",
        }}
      >
        <strong
          style={{
            color: "#f4f8fb",
            fontFamily: resolveFontFamily(fontFamily),
            fontWeight: 800,
            fontSize: format === "vertical" ? 42 : 34,
            lineHeight: 0.96,
            letterSpacing: "-0.04em",
          }}
        >
          {title}
        </strong>
        <span
          style={{
            color: "rgba(239, 247, 255, 0.76)",
            fontFamily: resolveFontFamily(fontFamily),
            fontWeight: 600,
            fontSize: format === "vertical" ? 22 : 18,
            lineHeight: 1.28,
          }}
        >
          {hook}
        </span>
      </div>
    </div>
  );
}

function VideoFrame({
  src,
  format,
  videoFillMode,
}: Pick<ClipRenderProps, "format" | "videoFillMode"> & { src: string }) {
  const foregroundInset = format === "vertical" ? 40 : 34;
  const foregroundRadius = format === "vertical" ? 34 : 28;

  if (videoFillMode === "cover") {
    return (
      <OffthreadVideo
        src={src}
        volume={0}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />
    );
  }

  if (videoFillMode === "contain") {
    return (
      <AbsoluteFill
        style={{
          display: "grid",
          placeItems: "center",
          padding: foregroundInset,
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: foregroundRadius,
            overflow: "hidden",
            boxShadow: "0 26px 54px rgba(0,0,0,0.36)",
            background: "#02080d",
          }}
        >
          <OffthreadVideo
            src={src}
            volume={0}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
            }}
          />
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={src}
        volume={0}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          filter: "blur(40px) saturate(1.05)",
          transform: "scale(1.08)",
          opacity: 0.54,
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at top left, rgba(93, 228, 199, 0.18), transparent 36%), linear-gradient(180deg, rgba(4, 12, 18, 0.12), rgba(4, 12, 18, 0.48))",
        }}
      />
      <AbsoluteFill
        style={{
          display: "grid",
          placeItems: "center",
          padding: foregroundInset,
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: foregroundRadius,
            overflow: "hidden",
            boxShadow: "0 28px 56px rgba(0,0,0,0.42)",
            background: "#02080d",
            border: "1px solid rgba(255, 255, 255, 0.08)",
          }}
          >
            <OffthreadVideo
              src={src}
              volume={0}
              style={{
                width: "100%",
                height: "100%",
              objectFit: "contain",
            }}
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

export function LiveClipComposition(props: ClipRenderProps) {
  const frame = useCurrentFrame();
  const mainVideoSrc = staticFile(props.videoSrc.replace(/^\//, ""));
  const introVideoSrc = props.introSrc ? staticFile(props.introSrc.replace(/^\//, "")) : null;
  const introIsImage = isImageAsset(props.introSrc);
  const outroVideoSrc = props.outroSrc ? staticFile(props.outroSrc.replace(/^\//, "")) : null;
  const musicSrc = props.musicSrc ? staticFile(props.musicSrc.replace(/^\//, "")) : null;
  const transitionFrames = Math.max(0, props.transitionFrames);
  const mainSequenceStart = props.introFrames;
  const mainClipEnd = mainSequenceStart + props.clipFrames;
  const outroSequenceStart = mainClipEnd + (outroVideoSrc ? transitionFrames : 0);
  const mainClipFrame = Math.max(0, frame - mainSequenceStart);
  const showDefaultIntroCard = !introVideoSrc && props.introFrames > 0;
  const hasOutro = Boolean(outroVideoSrc);

  return (
    <AbsoluteFill>
      <style>{ARCHIVO_FONT_FACE}</style>
      {musicSrc ? (
        <Sequence from={mainSequenceStart} durationInFrames={props.clipFrames}>
          <MusicBed
            src={musicSrc}
            clipFrames={props.clipFrames}
            musicPreset={props.musicPreset}
            musicVolume={props.musicVolume}
            musicFadeInFrames={props.musicFadeInFrames}
            musicFadeOutFrames={props.musicFadeOutFrames}
          />
        </Sequence>
      ) : null}
      <Sequence from={mainSequenceStart} durationInFrames={props.clipFrames}>
        <Audio src={mainVideoSrc} volume={props.sourceAudioVolume} />
      </Sequence>
      {props.introFrames > 0 ? (
        <Sequence from={0} durationInFrames={props.introFrames}>
          {introVideoSrc && introIsImage ? (
            <AbsoluteFill style={{ background: "#03080c" }}>
              <Img
                src={introVideoSrc}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </AbsoluteFill>
          ) : introVideoSrc ? (
            <AbsoluteFill style={{ background: "#03080c" }}>
              <OffthreadVideo
                src={introVideoSrc}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </AbsoluteFill>
          ) : showDefaultIntroCard ? (
            <DefaultIntroCard
              title={props.title}
              hook={props.hook}
              introFrames={props.introFrames}
              fontFamily={props.fontFamily}
            />
          ) : (
            <AbsoluteFill style={{ background: "#000000" }} />
          )}
        </Sequence>
      ) : null}

      <Sequence from={mainSequenceStart} durationInFrames={props.clipFrames + transitionFrames}>
        <MainClipLayer
          props={props}
          mainVideoSrc={mainVideoSrc}
          mainClipFrame={mainClipFrame}
          opacity={hasOutro
            ? interpolate(
                frame,
                [
                  mainSequenceStart,
                  mainSequenceStart + transitionFrames,
                  mainClipEnd,
                  outroSequenceStart,
                ],
                [transitionFrames > 0 ? 0 : 1, 1, 1, transitionFrames > 0 ? 0 : 1],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
              )
            : interpolate(
                frame,
                [mainSequenceStart, mainSequenceStart + transitionFrames],
                [transitionFrames > 0 ? 0 : 1, 1],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
              )}
        />
      </Sequence>

      {outroVideoSrc ? (
        <Sequence from={outroSequenceStart} durationInFrames={props.durationInFrames - outroSequenceStart}>
          <AbsoluteFill style={{ background: "#03080c" }}>
            <OffthreadVideo
              src={outroVideoSrc}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          </AbsoluteFill>
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
}

function MainClipLayer({
  props,
  mainVideoSrc,
  mainClipFrame,
  opacity,
}: {
  props: ClipRenderProps;
  mainVideoSrc: string;
  mainClipFrame: number;
  opacity: number;
}) {
  return (
    <AbsoluteFill style={{ opacity }}>
          <AbsoluteFill
            style={{
              background:
                "radial-gradient(circle at top left, rgba(93, 228, 199, 0.16), transparent 35%), linear-gradient(180deg, #040c12 0%, #08131b 100%)",
            }}
          >
            <AbsoluteFill>
              <VideoFrame
                src={mainVideoSrc}
                format={props.format}
                videoFillMode={props.videoFillMode}
              />
              <AbsoluteFill
                style={{
                  background:
                    "linear-gradient(180deg, rgba(3, 8, 12, 0.46) 0%, rgba(3, 8, 12, 0.14) 24%, rgba(3, 8, 12, 0.08) 42%, rgba(3, 8, 12, 0.4) 70%, rgba(3, 8, 12, 0.82) 100%)",
                }}
              />
              <ClipHud
                title={props.title}
                hook={props.hook}
                format={props.format}
                clipFrame={mainClipFrame}
                fontFamily={props.fontFamily}
              />
              <WordCaptions
                captions={props.captions}
                subtitleCues={props.subtitleCues}
                captionStyle={props.captionStyle}
                captionFontSize={props.captionFontSize}
                captionColor={props.captionColor}
                captionPlacement={props.captionPlacement}
                format={props.format}
                fontFamily={props.fontFamily}
                subtitleMode={props.subtitleMode}
                captionTimingOffsetMs={props.captionTimingOffsetMs}
              />
            </AbsoluteFill>
          </AbsoluteFill>
    </AbsoluteFill>
  );
}
