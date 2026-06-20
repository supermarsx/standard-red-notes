#!/usr/bin/env node
// Polyfill MUST be imported before any @standardnotes/* import (browser globals).
import './polyfill.js'

import { promises as fs } from 'node:fs'
import { bootstrapHeadlessApp, type HeadlessApp } from './bootstrap.js'
import { NotesClient, type FullNote } from './NotesClient.js'
import {
  clearActiveProfile,
  dataDirFor,
  getActiveProfile,
  profileIdFor,
  setActiveProfile,
  type Profile,
} from './config.js'

const CLI_VERSION = '0.1.0'

interface ParsedArgs {
  _: string[]
  flags: Record<string, string | boolean>
}

/** Tiny zero-dependency arg parser: --key=value, --key value, --bool, -h. */
function parseArgs(argv: string[]): ParsedArgs {
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

function flagStr(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name]
  return typeof v === 'string' ? v : undefined
}

/**
 * Exit after a short tick so closing async handles (sockets opened by snjs sync)
 * finish closing first; otherwise process.exit() mid-close trips a libuv
 * UV_HANDLE_CLOSING assertion on Node/Windows.
 */
/** Thrown by exit() to unwind the stack; main() swallows it. */
class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`)
  }
}

function exit(code: number): never {
  // Set the code and unwind via a sentinel rather than calling process.exit():
  // forcing exit while a socket handle is mid-close trips a libuv
  // UV_HANDLE_CLOSING assertion on Node/Windows. Once the stack unwinds and
  // handles close, Node exits naturally with process.exitCode.
  process.exitCode = code
  throw new ExitSignal(code)
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`)
  exit(1)
}

/** Boot an authenticated headless app for the active (or specified) profile. */
async function withSession<T>(
  args: ParsedArgs,
  fn: (headless: HeadlessApp, profile: Profile) => Promise<T>,
): Promise<T> {
  const profile = await getActiveProfile()
  if (!profile) {
    fail('Not logged in. Run `srn-client login --server <url> --email <email> --password <pw>` first.')
  }
  const serverKey = flagStr(args.flags, 'server-key') ?? profile.serverKey
  const headless = await bootstrapHeadlessApp({
    serverUrl: profile.serverUrl,
    dataDir: dataDirFor(profile.profileId),
    serverKey,
  })
  try {
    if (!headless.isSignedIn()) {
      throw new Error('Stored session is no longer valid. Run `srn-client login` again.')
    }
    await headless.sync()
    return await fn(headless, profile)
  } finally {
    await headless.deinit().catch(() => {})
  }
}

// --- commands ----------------------------------------------------------------

async function cmdLogin(args: ParsedArgs): Promise<number> {
  const serverUrl = flagStr(args.flags, 'server') ?? process.env.SRN_SERVER_URL
  const email = flagStr(args.flags, 'email')
  const password = flagStr(args.flags, 'password') ?? process.env.SRN_PASSWORD
  const mfa = flagStr(args.flags, 'mfa')
  const serverKey = flagStr(args.flags, 'server-key') ?? process.env.SHARED_SERVER_ACCESS_KEY
  const register = Boolean(args.flags.register)

  if (!serverUrl) {
    fail('Missing --server <url> (or set SRN_SERVER_URL).')
  }
  if (!email) {
    fail('Missing --email <email>.')
  }
  if (!password) {
    fail('Missing --password <pw> (or set SRN_PASSWORD; avoid putting passwords in shell history).')
  }

  const profileId = profileIdFor(serverUrl, email)
  const dataDir = dataDirFor(profileId)
  // Fresh login starts from a clean keychain so a stale session can't interfere.
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})

  const headless = await bootstrapHeadlessApp({ serverUrl, dataDir, password, mfaCode: mfa, serverKey })
  try {
    if (register) {
      await headless.register(email, password)
    } else {
      await headless.signIn(email, password, mfa)
    }
    if (!headless.isSignedIn()) {
      throw new Error('authentication did not establish a session (check credentials / server URL).')
    }
    await headless.sync()
    await setActiveProfile({ serverUrl, email, profileId, serverKey })
    const user = headless.getUser()
    process.stdout.write(`Logged in as ${user?.email ?? email} on ${serverUrl}\n`)
    process.stdout.write(`Session stored under ${dataDir} (keychain mode 0600/0700).\n`)
    return 0
  } catch (err) {
    await headless.deinit().catch(() => {})
    // Don't leave a half-written keychain that masquerades as a valid session.
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    fail((err as Error).message)
  } finally {
    await headless.deinit().catch(() => {})
  }
  return 0
}

async function cmdLogout(): Promise<number> {
  const profile = await getActiveProfile()
  if (!profile) {
    process.stdout.write('No active session.\n')
    return 0
  }
  await clearActiveProfile()
  process.stdout.write(`Logged out (cleared local session for ${profile.email}).\n`)
  return 0
}

async function cmdWhoami(args: ParsedArgs): Promise<number> {
  const profile = await getActiveProfile()
  if (!profile) {
    process.stdout.write('Not logged in.\n')
    return 1
  }
  // Offline answer from stored profile, then confirm against the server.
  process.stdout.write(`email:  ${profile.email}\nserver: ${profile.serverUrl}\n`)
  if (profile.serverKey) {
    process.stdout.write('server-key: configured (X-Shared-Server-Key will be sent)\n')
  }
  await withSession(args, async (headless) => {
    const user = headless.getUser()
    if (user?.uuid) {
      process.stdout.write(`uuid:   ${user.uuid}\n`)
    }
    process.stdout.write('session: valid\n')
  })
  return 0
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

async function cmdNotes(args: ParsedArgs): Promise<number> {
  const sub = args._.shift()
  switch (sub) {
    case 'list':
      return withSession(args, async (headless) => {
        const client = new NotesClient(headless)
        const limit = flagStr(args.flags, 'limit') ? Number(flagStr(args.flags, 'limit')) : undefined
        const notes = await client.listNotes(limit)
        if (args.flags.json) {
          printJson(notes)
        } else if (notes.length === 0) {
          process.stdout.write('(no notes)\n')
        } else {
          for (const n of notes) {
            process.stdout.write(`${n.uuid}  ${n.updatedAt}  ${n.title || '(untitled)'}\n`)
          }
        }
        return 0
      })
    case 'get': {
      const uuid = args._[0]
      if (!uuid) {
        fail('Usage: srn-client notes get <uuid>')
      }
      return withSession(args, async (headless) => {
        const note = await new NotesClient(headless).readNote(uuid)
        if (args.flags.json) {
          printJson(note)
        } else {
          process.stdout.write(`# ${note.title || '(untitled)'}\n`)
          if (note.tags.length) {
            process.stdout.write(`tags: ${note.tags.join(', ')}\n`)
          }
          process.stdout.write(`uuid: ${note.uuid}\nupdated: ${note.updatedAt}\n\n${note.text}\n`)
        }
        return 0
      })
    }
    case 'create': {
      const title = flagStr(args.flags, 'title')
      if (!title) {
        fail('Usage: srn-client notes create --title <t> [--text <body>] [--tag <name> ...]')
      }
      const text = flagStr(args.flags, 'text') ?? ''
      const tags = collectTags(args)
      return withSession(args, async (headless) => {
        const created = await new NotesClient(headless).createNote({ title, text, tags })
        printJson(created)
        return 0
      })
    }
    case 'update': {
      const uuid = args._[0]
      if (!uuid) {
        fail('Usage: srn-client notes update <uuid> [--title <t>] [--text <body>] [--tag <name> ...]')
      }
      const patch: { title?: string; text?: string; tags?: string[] } = {}
      if (flagStr(args.flags, 'title') !== undefined) {
        patch.title = flagStr(args.flags, 'title')
      }
      if (flagStr(args.flags, 'text') !== undefined) {
        patch.text = flagStr(args.flags, 'text')
      }
      const tags = collectTags(args)
      if (tags.length) {
        patch.tags = tags
      }
      if (Object.keys(patch).length === 0) {
        fail('Nothing to update. Provide --title, --text, and/or --tag.')
      }
      return withSession(args, async (headless) => {
        const updated = await new NotesClient(headless).updateNote(uuid, patch)
        printJson(updated)
        return 0
      })
    }
    case 'delete': {
      const uuid = args._[0]
      if (!uuid) {
        fail('Usage: srn-client notes delete <uuid>')
      }
      return withSession(args, async (headless) => {
        await new NotesClient(headless).deleteNote(uuid)
        process.stdout.write(`deleted ${uuid}\n`)
        return 0
      })
    }
    default:
      fail(`Unknown notes subcommand: ${sub ?? '(none)'}. Try: list, get, create, update, delete.`)
  }
  return 0
}

/** Collect repeated --tag flags (the simple parser keeps only the last; support comma lists). */
function collectTags(args: ParsedArgs): string[] {
  const raw = flagStr(args.flags, 'tag') ?? flagStr(args.flags, 'tags')
  if (!raw) {
    return []
  }
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

function toMarkdown(notes: FullNote[]): string {
  return notes
    .map((n) => {
      const header = `# ${n.title || '(untitled)'}\n`
      const meta = `<!-- uuid: ${n.uuid} | updated: ${n.updatedAt}${
        n.tags.length ? ` | tags: ${n.tags.join(', ')}` : ''
      } -->\n\n`
      return header + meta + (n.text ?? '')
    })
    .join('\n\n---\n\n')
}

async function cmdExport(args: ParsedArgs): Promise<number> {
  const format = (flagStr(args.flags, 'format') ?? 'json').toLowerCase()
  if (format !== 'json' && format !== 'md') {
    fail('--format must be json or md')
  }
  const out = flagStr(args.flags, 'out')
  return withSession(args, async (headless) => {
    const notes = await new NotesClient(headless).exportAll()
    const content = format === 'md' ? toMarkdown(notes) : JSON.stringify(notes, null, 2)
    if (out) {
      await fs.writeFile(out, content, { mode: 0o600 })
      process.stdout.write(`Exported ${notes.length} note(s) to ${out} (${format}).\n`)
    } else {
      process.stdout.write(content + '\n')
    }
    return 0
  })
}

async function cmdImport(args: ParsedArgs): Promise<number> {
  const file = args._[0]
  if (!file) {
    fail('Usage: srn-client import <file.json>  (JSON array of {title, text, tags?})')
  }
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    fail(`Cannot read ${file}: ${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw!)
  } catch {
    fail(`${file} is not valid JSON. Import expects a JSON array of notes.`)
  }
  if (!Array.isArray(parsed)) {
    fail('Import file must be a JSON array of { title, text, tags? } objects.')
  }
  const records = parsed as Array<{ title?: string; text?: string; tags?: string[] }>
  return withSession(args, async (headless) => {
    const client = new NotesClient(headless)
    let created = 0
    for (const rec of records) {
      const title = typeof rec.title === 'string' ? rec.title : ''
      const text = typeof rec.text === 'string' ? rec.text : ''
      const tags = Array.isArray(rec.tags) ? rec.tags.filter((t): t is string => typeof t === 'string') : []
      if (!title && !text) {
        continue
      }
      await client.createNote({ title: title || '(untitled)', text, tags })
      created++
    }
    process.stdout.write(`Imported ${created} note(s) from ${file}.\n`)
    return 0
  })
}

const HELP = `srn-client ${CLI_VERSION} — manage a Standard Red Notes account (real end-to-end-encrypted CRUD)

USAGE
  srn-client <command> [options]

AUTH
  login                Sign in and store the session locally (~/.srn)
    --server <url>       Server base URL (or $SRN_SERVER_URL)
    --email <email>
    --password <pw>      (or $SRN_PASSWORD — prefer the env var over shell history)
    --mfa <code>         TOTP / 2FA code, if the account requires it
    --server-key <key>   X-Shared-Server-Key gate value (or $SHARED_SERVER_ACCESS_KEY)
    --register           Create a NEW account instead of signing in
  logout               Clear the stored local session and keys
  whoami               Show the active account and confirm the session

NOTES
  notes list [--limit N] [--json]
  notes get <uuid> [--json]
  notes create --title <t> [--text <body>] [--tag a,b]
  notes update <uuid> [--title <t>] [--text <body>] [--tag a,b]
  notes delete <uuid>

DATA
  export [--out <file>] [--format json|md]
  import <file.json>     JSON array of { title, text, tags? }

OTHER
  version              Print the CLI version
  help                 Show this help

NOTES ON SECURITY
  Notes are end-to-end encrypted: they are decrypted locally by an embedded
  headless snjs client and synced back encrypted. The session keychain is stored
  under ~/.srn/data/<profile>/ with restrictive file permissions. Passwords and
  the shared-server-key are never logged.

EXAMPLES
  srn-client login --server http://localhost:3000 --email me@example.com --password 'secret'
  srn-client notes create --title "Hello" --text "world" --tag inbox,ideas
  srn-client notes list --limit 20
  srn-client export --out backup.json --format json
`

async function dispatch(): Promise<void> {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const command = args._.shift()

  if (!command || command === 'help' || args.flags.help) {
    process.stdout.write(HELP)
    exit(command && command !== 'help' && !args.flags.help ? 1 : 0)
  }

  let code = 0
  switch (command) {
    case 'login':
      code = await cmdLogin(args)
      break
    case 'logout':
      code = await cmdLogout()
      break
    case 'whoami':
      code = await cmdWhoami(args)
      break
    case 'notes':
      code = await cmdNotes(args)
      break
    case 'export':
      code = await cmdExport(args)
      break
    case 'import':
      code = await cmdImport(args)
      break
    case 'version':
      process.stdout.write(`srn-client ${CLI_VERSION}\n`)
      break
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
      code = 1
  }
  exit(code)
}

async function main(): Promise<void> {
  try {
    await dispatch()
  } catch (err) {
    if (err instanceof ExitSignal) {
      // Intentional exit (help / fail / explicit code). exitCode already set.
      return
    }
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    process.exitCode = 1
  }
}

void main()
