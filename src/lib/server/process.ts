import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

function createAbortError() {
  const error = new Error("The command was aborted.");
  error.name = "AbortError";
  return error;
}

function terminateChild(child: ReturnType<typeof spawn>) {
  if (child.killed) {
    return;
  }

  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to killing the direct child if the process group is gone.
    }
  }

  child.kill("SIGTERM");
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export function runCommand(
  command: string,
  args: string[],
  cwd = process.cwd(),
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const abortHandler = () => {
      aborted = true;
      terminateChild(child);
    };

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      options?.signal?.removeEventListener("abort", abortHandler);
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    if (options?.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateChild(child);
      }, options.timeoutMs);
    }

    options?.signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        options?.onStdoutLine?.(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrBuffer += text;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        options?.onStderrLine?.(line);
      }
    });

    child.on("error", (error) => {
      settle(() => {
        reject(aborted ? createAbortError() : error);
      });
    });

    child.on("close", (exitCode) => {
      settle(() => {
        if (stdoutBuffer) {
          options?.onStdoutLine?.(stdoutBuffer);
        }
        if (stderrBuffer) {
          options?.onStderrLine?.(stderrBuffer);
        }

        if (aborted) {
          reject(createAbortError());
          return;
        }

        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? 0,
          timedOut,
        });
      });
    });
  });
}
