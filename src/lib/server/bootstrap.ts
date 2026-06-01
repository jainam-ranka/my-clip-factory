import { ensureAppRuntime } from "./runtime";
import { getDb } from "./db";

export function bootstrapDataStore() {
  getDb();
}

export function bootstrapServer() {
  bootstrapDataStore();

  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  const lifecycle = process.env.npm_lifecycle_event;
  const isAppServer =
    lifecycle === "dev" ||
    lifecycle === "start" ||
    process.env.NODE_ENV === "development";
  if (!isAppServer && process.env.CLIP_FACTORY_ENABLE_RUNTIME !== "true") {
    return;
  }

  ensureAppRuntime();
}
