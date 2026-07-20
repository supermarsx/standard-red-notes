/**
 * Pure CLI core for srn-server: argument parsing, `docker compose` argv
 * construction and endpoint resolution. Nothing here spawns a process, opens a
 * socket or touches the filesystem.
 *
 * Kept out of index.ts (which runs `main()` on import, so it cannot be imported
 * from a test) and kept dependency-free — including of sibling modules — so the
 * unit tests can load it directly from source.
 */

// --- arguments ---------------------------------------------------------------

export interface ParsedArgs {
  _: string[]
  flags: Record<string, string | boolean>
}

/** The short aliases documented in HELP, mapped to their long flag names. */
const SHORT_FLAGS: Record<string, string> = { '-h': 'help', '-f': 'follow' }

/**
 * Tiny arg parser: `--key=value`, `--key value`, `--bool`, plus the short
 * aliases in SHORT_FLAGS.
 *
 * A `--key` whose next token starts with ANY `-` is treated as a boolean, so
 * `--follow -f` yields two flags rather than swallowing `-f` as a value.
 * Any other dash-leading token is dropped rather than becoming a positional —
 * an unrecognised switch must never be mistaken for a service name.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const _: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (SHORT_FLAGS[token]) {
      flags[SHORT_FLAGS[token]] = true
      continue
    }
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }
      continue
    }
    if (token.startsWith('-')) {
      continue
    }
    _.push(token)
  }
  return { _, flags }
}

/** Read a flag only if it carries a string value (a bare `--flag` yields undefined). */
export function flagStr(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name]
  return typeof v === 'string' ? v : undefined
}

// --- docker compose argv -----------------------------------------------------
//
// These commands act on a real stack, so a silent argv regression (a dropped
// `-d`, a stray `--volumes`) is expensive — hence they are built purely and
// asserted directly rather than being assembled inline at the spawn site.

export function composeLogsArgs(args: ParsedArgs): string[] {
  const composeArgs = ['compose', 'logs']
  if (args.flags.follow || args.flags.f) {
    composeArgs.push('-f')
  }
  const tail = flagStr(args.flags, 'tail')
  if (tail) {
    composeArgs.push('--tail', tail)
  }
  const service = args._[0]
  if (service) {
    composeArgs.push(service)
  }
  return composeArgs
}

/** `up` always runs detached; `--build` and an optional single service are additive. */
export function composeUpArgs(args: ParsedArgs): string[] {
  const composeArgs = ['compose', 'up', '-d']
  if (args.flags.build) {
    composeArgs.push('--build')
  }
  const service = args._[0]
  if (service) {
    composeArgs.push(service)
  }
  return composeArgs
}

/** `down` never takes a service; `--volumes` is the data-destroying opt-in. */
export function composeDownArgs(args: ParsedArgs): string[] {
  const composeArgs = ['compose', 'down']
  if (args.flags.volumes) {
    composeArgs.push('--volumes')
  }
  return composeArgs
}

// --- endpoints ---------------------------------------------------------------

export const DEFAULT_BASE_URL = 'http://localhost:3001'
export const DEFAULT_TIMEOUT_MS = 5000

export interface Probe {
  name: string
  url: string
}

/** Strip exactly one trailing slash so `${base}/healthcheck` never doubles up. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

export function defaultProbes(baseUrl: string): Probe[] {
  const base = normalizeBaseUrl(baseUrl)
  return [{ name: 'api-gateway (server)', url: `${base}/healthcheck` }]
}

/** `--url` beats $SRN_SERVER_URL beats the loopback default. */
export function resolveBaseUrl(args: ParsedArgs, processEnv: Record<string, string | undefined>): string {
  return flagStr(args.flags, 'url') ?? processEnv.SRN_SERVER_URL ?? DEFAULT_BASE_URL
}

/** `--server-key` beats $SHARED_SERVER_ACCESS_KEY; undefined means "send no gate header". */
export function resolveSharedKey(args: ParsedArgs, processEnv: Record<string, string | undefined>): string | undefined {
  return flagStr(args.flags, 'server-key') ?? processEnv.SHARED_SERVER_ACCESS_KEY
}

/** Build the gate header set. An absent key means no header at all, not an empty one. */
export function gateHeaders(sharedKey: string | undefined): Record<string, string> {
  return sharedKey ? { 'X-Shared-Server-Key': sharedKey } : {}
}
