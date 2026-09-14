import { inspect } from 'node:util'

/** The minimal variadic logger the websocket-gateway package writes to. */
export interface GatewayLoggerBridge {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

/** The slice of a winston logger the bridge needs (message-only calls). */
export interface LeveledHostLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
  debug(message: string): unknown
}

/**
 * Standard Red Notes (N1): one gateway log argument as text. Strings pass
 * through; everything else is serialised, because the previous bridge did
 * `args.map(String)` and turned every metadata object — the per-push
 * `{ socketCount }` line, every redacted `{ errorType, errorCode }` — into the
 * literal `[object Object]`, which is what 37 lines of the live api-gateway log
 * said. `Error` instances go through `inspect` (JSON would yield `{}`), as does
 * anything JSON cannot represent (circular, BigInt, `undefined`).
 */
export function formatGatewayLogArgument(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value instanceof Error) {
    return inspect(value)
  }
  try {
    const json = JSON.stringify(value)

    return json === undefined ? inspect(value) : json
  } catch {
    return inspect(value)
  }
}

/**
 * Adapt the host's leveled logger to the gateway's variadic one: each call
 * becomes a single message line with every argument rendered readably.
 */
export function createGatewayLoggerBridge(logger: LeveledHostLogger): GatewayLoggerBridge {
  const line = (args: unknown[]): string => args.map(formatGatewayLogArgument).join(' ')

  return {
    info: (...args: unknown[]): void => void logger.info(line(args)),
    warn: (...args: unknown[]): void => void logger.warn(line(args)),
    error: (...args: unknown[]): void => void logger.error(line(args)),
    debug: (...args: unknown[]): void => void logger.debug(line(args)),
  }
}
