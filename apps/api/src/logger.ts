import pino, { type Logger } from "pino";
import type { LogContext } from "@fina/shared";

const isTest = process.env.NODE_ENV === "test";

export const logger: Logger = pino({
  level: isTest ? "silent" : (process.env.LOG_LEVEL ?? "info"),
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Default `pid` and `hostname` are noise in containerised deploys;
  // drop them. Reinstate if a future log aggregator needs them.
  base: undefined,
});

export function logInfo(ctx: LogContext, msg: string): void {
  logger.info(ctx, msg);
}
export function logWarn(ctx: LogContext, msg: string): void {
  logger.warn(ctx, msg);
}
export function logError(ctx: LogContext, msg: string): void {
  logger.error(ctx, msg);
}
export function logFatal(ctx: LogContext, msg: string): void {
  logger.fatal(ctx, msg);
}
