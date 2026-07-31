#!/usr/bin/env node
/**
 * srn-server — operational CLI for a self-hosted Standard Red Notes instance.
 *
 * Safe, non-destructive helpers for operators of the Docker stack:
 *   - health   probe HTTP healthcheck endpoints of the running services
 *   - status   `docker compose ps` for the stack
 *   - logs     `docker compose logs [service]`
 *   - up       `docker compose up -d` (build optional)
 *   - down     `docker compose down`  (DESTRUCTIVE-ish; requires --yes)
 *   - config   validate/show resolved required env vars from .env
 *   - version  print CLI + (if reachable) server build info
 *
 * Design notes:
 *   - Zero runtime dependencies (Node built-ins only) so it stays a standalone
 *     package that never touches the app/server lockfiles.
 *   - Docker-wrapping commands shell out to `docker compose` from the repo root
 *     (auto-located by walking up for docker-compose.yml). Endpoint commands use
 *     fetch only.
 *   - No secrets are ever printed: `config` reports presence/validity, never the
 *     value of a secret.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  composeDownArgs,
  composeLogsArgs,
  composeUpArgs,
  DEFAULT_TIMEOUT_MS,
  defaultProbes,
  flagStr,
  gateHeaders,
  parseArgs,
  resolveBaseUrl,
  resolveSharedKey,
  type ParsedArgs,
  type Probe,
} from './cli.js'
import { checkRequiredSecret, parseEnvFile, REQUIRED_KEYS, resolveEnvValue, sharedKeyGate } from './env.js'

const CLI_VERSION = '0.1.0'

if (process.argv.length === 3 && process.argv[2] === '--srn-release-self-test') {
  process.stdout.write(`srn-native-self-test-v1 ${process.platform} ${process.arch}\n`)
  process.exit(0)
}

/** Thrown by exit() to unwind the stack; main() swallows it. */
class ExitSignal extends Error {
  // Declared as an explicit field rather than a constructor parameter property:
  // parameter properties are not erasable syntax, so Node's strip-only type
  // stripping refuses to load the module. Keeping every source file loadable by
  // `node --test` directly is what lets the test suite exercise this entry point.
  public readonly code: number

  constructor(code: number) {
    super(`exit ${code}`)
    this.code = code
  }
}

/**
 * Set the exit code and unwind via a sentinel rather than calling process.exit():
 * forcing exit while a fetch socket / child-stdio handle is mid-close trips a
 * libuv UV_HANDLE_CLOSING assertion on Node/Windows. Once the stack unwinds and
 * handles close, Node exits naturally with process.exitCode.
 */
function exit(code: number): never {
  process.exitCode = code
  throw new ExitSignal(code)
}

/** Walk up from a starting dir to find the repo root (the dir with docker-compose.yml). */
async function findRepoRoot(start: string): Promise<string | undefined> {
  let dir = start
  for (let i = 0; i < 12; i++) {
    try {
      await fs.access(path.join(dir, 'docker-compose.yml'))
      return dir
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return undefined
}

async function resolveRepoRoot(flags: Record<string, string | boolean>): Promise<string> {
  const explicit = flagStr(flags, 'repo')
  if (explicit) {
    return path.resolve(explicit)
  }
  const root = await findRepoRoot(process.cwd())
  if (!root) {
    throw new Error(
      'Could not locate the repo root (no docker-compose.yml found walking up from the current directory). ' +
        'Run from inside the repo, or pass --repo <path-to-repo>.',
    )
  }
  return root
}

/** Run a child process inheriting stdio. Resolves with the exit code (never rejects on non-zero). */
function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    // No `shell`: `docker` is an executable (docker.exe on Windows) resolvable on
    // PATH, so direct spawn avoids shell-argument-escaping concerns entirely.
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' })
    child.on('error', (err) => {
      process.stderr.write(`Failed to run \`${cmd}\`: ${(err as Error).message}\n`)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        process.stderr.write('Is Docker installed and on your PATH?\n')
      }
      resolve(127)
    })
    child.on('close', (code) => resolve(code ?? 0))
  })
}

/** Run a child process and capture stdout (used for `docker compose config`). */
function capture(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + (err as Error).message }))
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

// --- HTTP health -------------------------------------------------------------

async function probe(p: Probe, sharedKey: string | undefined, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(p.url, { signal: controller.signal, headers: gateHeaders(sharedKey) })
    const body = (await res.text().catch(() => '')).trim().slice(0, 80)
    if (res.ok) {
      return `  ok   ${p.name.padEnd(22)} ${res.status} ${body}`
    }
    return `  FAIL ${p.name.padEnd(22)} ${res.status} ${body}`
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'timeout' : (err as Error).message
    return `  DOWN ${p.name.padEnd(22)} ${msg}`
  } finally {
    clearTimeout(timer)
  }
}

// --- commands ----------------------------------------------------------------

async function cmdHealth(args: ParsedArgs): Promise<number> {
  const baseUrl = resolveBaseUrl(args, process.env)
  const sharedKey = resolveSharedKey(args, process.env)
  const timeoutMs = Number(flagStr(args.flags, 'timeout') ?? String(DEFAULT_TIMEOUT_MS))
  process.stdout.write(`Health probe against ${baseUrl}\n`)
  const probes = defaultProbes(baseUrl)
  let anyFail = false
  for (const p of probes) {
    const line = await probe(p, sharedKey, timeoutMs)
    if (!line.startsWith('  ok')) {
      anyFail = true
    }
    process.stdout.write(line + '\n')
  }
  return anyFail ? 1 : 0
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const root = await resolveRepoRoot(args.flags)
  return run('docker', ['compose', 'ps'], root)
}

async function cmdLogs(args: ParsedArgs): Promise<number> {
  const root = await resolveRepoRoot(args.flags)
  return run('docker', composeLogsArgs(args), root)
}

async function cmdUp(args: ParsedArgs): Promise<number> {
  const root = await resolveRepoRoot(args.flags)
  const composeArgs = composeUpArgs(args)
  process.stdout.write(`Starting stack: docker ${composeArgs.join(' ')} (cwd ${root})\n`)
  return run('docker', composeArgs, root)
}

async function cmdDown(args: ParsedArgs): Promise<number> {
  if (!args.flags.yes) {
    process.stderr.write(
      'Refusing to run `docker compose down` without explicit confirmation.\n' +
        'This stops and removes the stack containers. Re-run with --yes to proceed.\n' +
        'Add --volumes to also delete data volumes (DESTROYS ALL DATA).\n',
    )
    return 2
  }
  const root = await resolveRepoRoot(args.flags)
  const composeArgs = composeDownArgs(args)
  process.stdout.write(`Stopping stack: docker ${composeArgs.join(' ')} (cwd ${root})\n`)
  return run('docker', composeArgs, root)
}

async function cmdConfig(args: ParsedArgs): Promise<number> {
  const root = await resolveRepoRoot(args.flags)
  const envPath = path.resolve(flagStr(args.flags, 'env') ?? path.join(root, '.env'))
  process.stdout.write(`Resolving config from ${envPath}\n`)

  let env: Record<string, string> = {}
  let envExists = true
  try {
    env = parseEnvFile(await fs.readFile(envPath, 'utf8'))
  } catch {
    envExists = false
    process.stdout.write(
      'No .env found. The stack uses docker-compose defaults (dev-only, NOT safe for production).\n' +
        'Run ./scripts/setup.sh (or setup.ps1) to generate a real .env with secure secrets.\n',
    )
  }

  let problems = 0
  process.stdout.write('\nRequired secrets:\n')
  for (const key of REQUIRED_KEYS) {
    const verdict = checkRequiredSecret(key, resolveEnvValue(key, process.env, env))
    switch (verdict.status) {
      case 'missing':
        // Missing from .env is only a hard error when no .env exists at all; with a
        // .env present, a missing required key means the stack falls back to an
        // insecure compose default — flag it.
        process.stdout.write(`  MISSING  ${key} (will use insecure compose default)\n`)
        problems++
        break
      case 'placeholder':
        process.stdout.write(`  PLACEHOLDER ${key} (still contains CHANGE-ME — replace it)\n`)
        problems++
        break
      case 'weak':
        process.stdout.write(`  WEAK     ${key} (should be 64-char hex / 32 random bytes)\n`)
        problems++
        break
      default:
        // Never print the secret value — only that it is set and well-formed.
        process.stdout.write(`  ok       ${key} (set, ${verdict.length} chars)\n`)
    }
  }

  const gate = sharedKeyGate(process.env, env)
  process.stdout.write('\nShared server access key gate:\n')
  if (gate.enabled) {
    process.stdout.write(`  enabled  mode=${gate.mode} (clients must send X-Shared-Server-Key)\n`)
  } else {
    process.stdout.write('  off      (no SHARED_SERVER_ACCESS_KEY set; gate disabled)\n')
  }

  if (args.flags['compose-config']) {
    process.stdout.write('\nResolved docker compose config:\n')
    const result = await capture('docker', ['compose', 'config'], root)
    process.stdout.write(result.stdout)
    if (result.code !== 0) {
      process.stderr.write(result.stderr)
      return result.code
    }
  }

  if (!envExists) {
    return 1
  }
  if (problems > 0) {
    process.stdout.write(`\n${problems} config issue(s) found.\n`)
    return 1
  }
  process.stdout.write('\nConfig looks good.\n')
  return 0
}

async function cmdVersion(args: ParsedArgs): Promise<number> {
  process.stdout.write(`srn-server ${CLI_VERSION}\n`)
  const baseUrl = resolveBaseUrl(args, process.env)
  const sharedKey = resolveSharedKey(args, process.env)
  try {
    const res = await fetch(defaultProbes(baseUrl)[0].url, {
      headers: gateHeaders(sharedKey),
      signal: AbortSignal.timeout(4000),
    })
    process.stdout.write(`server ${baseUrl}: ${res.status} ${res.ok ? 'reachable' : 'error'}\n`)
  } catch (err) {
    process.stdout.write(`server ${baseUrl}: unreachable (${(err as Error).message})\n`)
  }
  return 0
}

const HELP = `srn-server ${CLI_VERSION} — operational CLI for a self-hosted Standard Red Notes stack

USAGE
  srn-server <command> [options]

COMMANDS
  health              Probe the server healthcheck endpoint over HTTP
  status              Show stack/service status (wraps \`docker compose ps\`)
  logs [service]      Tail service logs (wraps \`docker compose logs\`)
  up [service]        Start the stack (wraps \`docker compose up -d\`)
  down                Stop the stack (wraps \`docker compose down\`; needs --yes)
  config              Validate/show resolved required env vars from .env
  version             Print CLI version and probe server reachability
  help                Show this help

GLOBAL OPTIONS
  --repo <path>       Repo root (default: auto-located by docker-compose.yml)
  -h, --help          Show help

health / version OPTIONS
  --url <url>         Server base URL (default http://localhost:3001 / $SRN_SERVER_URL)
  --server-key <key>  X-Shared-Server-Key header value (or $SHARED_SERVER_ACCESS_KEY)
  --timeout <ms>      Per-probe timeout (default 5000)

logs OPTIONS
  -f, --follow        Follow log output
  --tail <n>          Show only the last N lines

up OPTIONS
  --build             Rebuild images before starting

down OPTIONS
  --yes               Required confirmation to actually stop the stack
  --volumes           Also remove data volumes (DESTROYS ALL DATA)

config OPTIONS
  --env <path>        Path to the .env file (default <repo>/.env)
  --compose-config    Also print the resolved \`docker compose config\`

EXAMPLES
  srn-server health --url http://localhost:3001
  srn-server config
  srn-server status
  srn-server logs server --tail 100
  srn-server up --build
  srn-server down --yes
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
    case 'health':
      code = await cmdHealth(args)
      break
    case 'status':
      code = await cmdStatus(args)
      break
    case 'logs':
      code = await cmdLogs(args)
      break
    case 'up':
      code = await cmdUp(args)
      break
    case 'down':
      code = await cmdDown(args)
      break
    case 'config':
      code = await cmdConfig(args)
      break
    case 'version':
      code = await cmdVersion(args)
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
      // Intentional exit; process.exitCode is already set.
      return
    }
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    process.exitCode = 1
  }
}

void main()
