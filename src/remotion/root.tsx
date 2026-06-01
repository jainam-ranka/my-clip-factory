import { Composition } from "remotion";
import type { ClipRenderProps } from "@/lib/types";
import { LiveClipComposition } from "./LiveClipComposition";

const defaultProps: ClipRenderProps = {
  format: "vertical",
  videoSrc: "/input-video.mp4",
  introSrc: null,
  outroSrc: null,
  musicSrc: null,
  musicPreset: "balanced",
  musicVolume: 0,
  musicFadeInFrames: 60,
  musicFadeOutFrames: 60,
  sourceAudioFadeOutFrames: 0,
  sourceAudioVolume: 1.25,
  transitionFrames: 18,
  durationInFrames: 1800,
  introFrames: 90,
  clipFrames: 1650,
  captions: [
    { text: "Live", startMs: 0, endMs: 600 },
    { text: "clip", startMs: 600, endMs: 1300 },
    { text: "preview", startMs: 1300, endMs: 2200 },
  ],
  captionTimingOffsetMs: 0,
  title: "Preview clip",
  hook: "Dynamic captions preview",
  captionStyle: "pill",
  captionFontSize: 52,
  captionColor: "#f4a60b",
  captionPlacement: "bottom",
  videoFillMode: "blur",
  fontFamily: "Archivo",
  fontSource: "google",
  subtitleMode: "phrase_1_4",
  camera: [],
};

export function RemotionRoot() {
  return (
    <Composition
      id="LiveClipComposition"
      component={LiveClipComposition}
      fps={30}
      width={1080}
      height={1920}
      durationInFrames={defaultProps.durationInFrames}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: props.durationInFrames,
        fps: 30,
        width: props.format === "vertical" ? 1080 : 1920,
        height: props.format === "vertical" ? 1920 : 1080,
        props,
      })}
    />
  );
}
