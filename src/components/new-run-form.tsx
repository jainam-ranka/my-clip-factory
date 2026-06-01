"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";

type CreateRunResponse = {
  run: {
    run: {
      id: string;
    };
  };
};

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

export function NewRunForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetchJson<CreateRunResponse>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          url,
          label: label || undefined,
        }),
      });

      router.push(`/runs/${response.run.run.id}`);
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not create run.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="url-form" onSubmit={onSubmit}>
      <div>
        <label className="field-label" htmlFor="source-url">
          Source URL
        </label>
        <input
          id="source-url"
          className="text-input"
          placeholder="https://youtube.com/watch?v=... or another supported video source"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
        />
        <p className="field-hint">Paste the source you want to monitor, review, and turn into clip exports.</p>
      </div>
      <div>
        <label className="field-label" htmlFor="source-label">
          Run Label
        </label>
        <input
          id="source-label"
          className="text-input"
          placeholder="Interview, keynote, gameplay session..."
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      <div className="button-row">
        <button className="button button-primary" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Starting..." : "Start Run"}
        </button>
      </div>
      {errorMessage ? (
        <p className="footer-note" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </form>
  );
}
