import type { FontSource } from "./types";

export type FontOption = {
  family: string;
  source: FontSource;
};

export const GOOGLE_FONT_OPTIONS: FontOption[] = [
  "Archivo",
  "Inter",
  "Sora",
  "Space Grotesk",
  "Bebas Neue",
  "Anton",
  "Manrope",
  "DM Sans",
  "Poppins",
  "Roboto Condensed",
].map((family) => ({ family, source: "google" as const }));

export const SYSTEM_FONT_OPTIONS: FontOption[] = [
  "Arial",
  "Avenir Next",
  "Helvetica Neue",
  "Georgia",
  "SF Pro Display",
  "Menlo",
].map((family) => ({ family, source: "system" as const }));

export const FONT_OPTIONS = [...GOOGLE_FONT_OPTIONS, ...SYSTEM_FONT_OPTIONS];

export function isKnownFont(family: string, source: FontSource) {
  return FONT_OPTIONS.some((font) => font.family === family && font.source === source);
}
