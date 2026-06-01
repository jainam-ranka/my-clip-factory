#!/usr/bin/env python3
import json
import sys


def main() -> int:
    if len(sys.argv) < 4:
        print("Usage: transcribe_faster_whisper.py <input> <output> <language>", file=sys.stderr)
        return 2

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    language = sys.argv[3]

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(f"faster-whisper import failed: {exc}", file=sys.stderr)
        return 1

    try:
        model = WhisperModel("base", device="auto", compute_type="auto")
        segments, _info = model.transcribe(
            input_path,
            language=language,
            beam_size=5,
            word_timestamps=True,
            vad_filter=False,
        )
    except Exception as exc:
        print(f"transcription failed: {exc}", file=sys.stderr)
        return 1

    words = []
    for segment in segments:
        for word in segment.words or []:
            text = (word.word or "").strip()
            if not text:
                continue
            words.append(
                {
                    "word": text,
                    "start": word.start,
                    "end": word.end,
                    "probability": getattr(word, "probability", None),
                }
            )

    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump({"words": words}, handle)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
