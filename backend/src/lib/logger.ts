import pino from "pino";
import pinoPretty from "pino-pretty";

/**
 * Structured logging (2026-07-13 backend audit #14: "console-only logging,
 * no error monitoring, no request logs, no correlation IDs"). Single shared
 * logger for both the API and worker processes.
 *
 * Pretty-printed, human-readable output in development (matches the plain
 * console.log output this replaces, so local dev output doesn't get worse);
 * plain JSON lines in production/test — the standard shape any log
 * aggregator (Railway's own log viewer included) can parse and filter on,
 * where console.log's free-text strings couldn't be queried by field at all.
 *
 * The real pino instance is created LAZILY, on the first actual log call,
 * rather than at module-load time — confirmed directly (2026-07-13) that
 * under tsx's dev runtime, this module can be reached (transitively, via
 * server.ts's `import { validateEnv }`) before server.ts's own
 * `dotenv.config()` call has run, so a module-top-level
 * `process.env.NODE_ENV` read here would silently and permanently decide
 * "not dev" for the whole process. Every real log call happens well after
 * startup/env-loading has finished, so deferring the check to first-use
 * sidesteps the whole load-order question rather than depending on it.
 */
let realLogger: pino.Logger | null = null;

function getRealLogger(): pino.Logger {
  if (!realLogger) {
    const isDev = process.env.NODE_ENV === "development";
    realLogger = isDev
      ? pino(pinoPretty({ colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" }))
      : pino({ level: process.env.LOG_LEVEL ?? "info" });
  }
  return realLogger;
}

export const logger = new Proxy({} as pino.Logger, {
  get(_target, prop, _receiver) {
    const real = getRealLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const value = (real as any)[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});
