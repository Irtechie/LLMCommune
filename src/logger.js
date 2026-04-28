// @ts-check
/**
 * Minimal structured JSON logger.
 * Emits one JSON object per line to stdout/stderr so log consumers can parse by line.
 *
 * @typedef {"debug"|"info"|"warn"|"error"} LogLevel
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[/** @type {LogLevel} */ (process.env.LOG_LEVEL || "info")] ?? LEVELS.info;

/**
 * @param {LogLevel} level
 * @param {string} msg
 * @param {Record<string, unknown>} [ctx]
 */
function log(level, msg, ctx) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(ctx || {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  /** @param {string} msg @param {Record<string, unknown>} [ctx] */
  debug: (msg, ctx) => log("debug", msg, ctx),
  /** @param {string} msg @param {Record<string, unknown>} [ctx] */
  info: (msg, ctx) => log("info", msg, ctx),
  /** @param {string} msg @param {Record<string, unknown>} [ctx] */
  warn: (msg, ctx) => log("warn", msg, ctx),
  /** @param {string} msg @param {Record<string, unknown>} [ctx] */
  error: (msg, ctx) => log("error", msg, ctx),
};
