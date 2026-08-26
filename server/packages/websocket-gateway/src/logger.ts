import { type Logger } from './redisBridge.js'
import { safeLogArguments } from './safeLog.js'

// ---------------------------------------------------------------------------
// Leveled logger for the standalone gateway process.
//
// Every other server package builds a winston logger whose verbosity comes from
// the LOG_LEVEL env var (see `auth/src/Bootstrap/Container.ts` and
// `syncing-server/src/Bootstrap/Container.ts`). This package intentionally has
// no winston dependency -- it is the lean module the api-gateway embeds -- so it
// reproduces the same CONTRACT rather than a new one: winston's npm level names,
// read from LOG_LEVEL, defaulting to `info`.
//
// This module is also the ONLY place in the package permitted to touch
// `console`: everything else takes a `Logger` so output is redacted and level
// controlled in one spot. Arguments always pass through `safeLogArguments`, so a
// caller cannot leak a token or note body into stdout by accident.
// ---------------------------------------------------------------------------

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const

export type LogLevelName = (typeof LOG_LEVELS)[number]

const LEVEL_SEVERITY: Readonly<Record<LogLevelName, number>> = Object.freeze({
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  silly: 6,
})

export const DEFAULT_LOG_LEVEL: LogLevelName = 'info'

/**
 * An unset, empty or unrecognized LOG_LEVEL falls back to `info` rather than
 * throwing: a typo in an operator's env must not take the gateway down, and
 * silently going quiet would be worse than being slightly noisy.
 */
export function resolveLogLevel(value: string | undefined): LogLevelName {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) {
    return DEFAULT_LOG_LEVEL
  }
  return (LOG_LEVELS as readonly string[]).includes(normalized) ? (normalized as LogLevelName) : DEFAULT_LOG_LEVEL
}

export function isLevelEnabled(configured: LogLevelName, candidate: Exclude<LogLevelName, 'silent'>): boolean {
  return LEVEL_SEVERITY[candidate] <= LEVEL_SEVERITY[configured]
}

export interface ConsoleLoggerSink {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface ConsoleLoggerOptions {
  /** Raw LOG_LEVEL value; unrecognized input falls back to `info`. */
  level?: string
  sink?: ConsoleLoggerSink
  now?: () => Date
}

export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Required<Logger> {
  const level = resolveLogLevel(options.level)
  // eslint-disable-next-line no-console
  const sink = options.sink ?? console
  const now = options.now ?? ((): Date => new Date())

  const write = (
    candidate: Exclude<LogLevelName, 'silent'>,
    target: (...args: unknown[]) => void,
    args: unknown[],
  ): void => {
    if (!isLevelEnabled(level, candidate)) {
      return
    }
    target(now().toISOString(), `[${candidate}]`, ...safeLogArguments(args))
  }

  return {
    debug: (...args) => write('debug', sink.log.bind(sink), args),
    info: (...args) => write('info', sink.log.bind(sink), args),
    warn: (...args) => write('warn', sink.warn.bind(sink), args),
    error: (...args) => write('error', sink.error.bind(sink), args),
  }
}
