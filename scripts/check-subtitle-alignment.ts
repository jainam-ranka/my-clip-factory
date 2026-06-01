import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcribeSegment } from "../src/lib/server/transcription";
import { listRecentTokens } from "../src/lib/server/repository";

const [videoPath, runId, sourceStartArg, sourceEndArg, mainStartArg = "2400"] = process.argv.slice(2);

if (!videoPath || !runId || !sourceStartArg || !sourceEndArg) {
  throw new Error("Usage: check-subtitle-alignment <videoPath> <runId> <sourceStartMs> <sourceEndMs> [mainStartMs]");
}

const sourceStartMs = Number(sourceStartArg);
const sourceEndMs = Number(sourceEndArg);
const mainSequenceStartMs = Number(mainStartArg);

function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9']/g, "");
}

void (async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-align-"));

  try {
    const rendered = await transcribeSegment({
      runId,
      segmentId: "align_render",
      videoPath,
      startOffsetMs: 0,
      outputDir,
    });
    const expected = listRecentTokens(runId, sourceStartMs)
      .filter((token) =>
        !token.isRemoved &&
        token.startMs <= sourceEndMs &&
        token.endMs >= sourceStartMs &&
        /[A-Za-z0-9]/.test(token.text)
      )
      .map((token) => ({
        text: token.text,
        startMs: token.startMs - sourceStartMs + mainSequenceStartMs,
      }));
    const actual = rendered.tokens
      .filter((token) => /[A-Za-z0-9]/.test(token.text))
      .map((token) => ({
        text: token.text,
        startMs: token.startMs,
      }));
    const matches: Array<{ word: string; expected: number; actual: number; delta: number }> = [];
    let cursor = 0;

    for (const expectedToken of expected) {
      const expectedText = normalize(expectedToken.text);
      if (!expectedText) continue;
      for (let index = cursor; index < actual.length; index += 1) {
        if (normalize(actual[index].text) === expectedText) {
          matches.push({
            word: expectedToken.text,
            expected: expectedToken.startMs,
            actual: actual[index].startMs,
            delta: actual[index].startMs - expectedToken.startMs,
          });
          cursor = index + 1;
          break;
        }
      }
      if (matches.length >= 100) break;
    }

    const deltas = matches.slice(0, 80).map((match) => match.delta).sort((left, right) => left - right);
    const medianDeltaMs = deltas[Math.floor(deltas.length / 2)] ?? null;
    const meanDeltaMs = deltas.length > 0
      ? Math.round(deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length)
      : null;

    console.log(JSON.stringify({
      renderedTokenCount: actual.length,
      expectedCount: expected.length,
      matchCount: matches.length,
      medianDeltaMs,
      meanDeltaMs,
      firstMatches: matches.slice(0, 40),
    }, null, 2));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
