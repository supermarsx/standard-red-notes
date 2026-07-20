/**
 * Zero-dependency CLI argument handling for srn-client.
 *
 * Kept in its own module (rather than inline in index.ts) so the parsing rules
 * are unit-testable: index.ts runs `main()` on import and therefore cannot be
 * imported from a test.
 */

export interface ParsedArgs {
  _: string[]
  flags: Record<string, string | boolean>
}

/**
 * Flags that take NO value. They must be declared, because the parser otherwise
 * cannot tell `--json <uuid>` (switch + note id) from `--limit 20` (flag +
 * value) and would bind the uuid as the switch's value, silently losing it.
 *
 * Keep in sync with HELP. Every other flag is value-taking: --server, --email,
 * --password, --mfa, --server-key, --limit, --title, --text, --tag, --tags,
 * --format, --out.
 */
const BOOLEAN_FLAGS = new Set(['help', 'register', 'json'])

/**
 * Tiny arg parser: `--key=value`, `--key value`, `--bool`, `-h`.
 *
 * A value-taking `--key` whose next token also starts with `--` is treated as a
 * boolean, so `--title --text body` does not swallow the `--text` switch. Note
 * this is deliberately looser than srn-server's parser, which stops on any
 * leading `-`: here a negative number (`--limit -1`) is consumed as the value.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const _: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '-h') {
      flags.help = true
      continue
    }
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }
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

/** Collect `--tag`/`--tags` values (the simple parser keeps only the last; support comma lists). */
export function collectTags(args: ParsedArgs): string[] {
  const raw = flagStr(args.flags, 'tag') ?? flagStr(args.flags, 'tags')
  if (!raw) {
    return []
  }
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}
