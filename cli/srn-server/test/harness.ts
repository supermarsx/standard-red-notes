/**
 * Test harness for end-to-end runs of `src/index.ts`.
 *
 * index.ts calls `main()` at import time, so it cannot be imported. It is
 * instead executed as a child process with:
 *   - a THROWAWAY sandbox cwd/repo root, never the real repo,
 *   - a fake `docker` first on PATH, so no command can reach a real daemon,
 *   - the ./x.js -> ./x.ts resolver so the child runs the real TypeScript
 *     sources (V8 coverage from the child is merged by `node --test`, so this
 *     measures src/index.ts, not dist/).
 */
import { spawn } from 'node:child_process'
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ENTRY = path.join(here, '..', 'src', 'index.ts')
// `--import` takes a URL, and a Windows absolute path is not one ('f:' is read
// as an unsupported scheme), so it must be passed as an explicit file:// URL.
const REGISTER = pathToFileURL(path.join(here, 'register-ts-resolver.mjs')).href

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * A sandbox holding a fake `docker`, a fake repo root and .env fixtures.
 * Everything lives under the OS temp dir; the real repo is never touched.
 */
export interface Sandbox {
  dir: string
  /** A directory containing docker-compose.yml (a valid --repo target). */
  repo: string
  /** A directory with no docker-compose.yml anywhere above it. */
  orphan: string
  /** Directory holding the fake `docker`; first on PATH by default. */
  bin: string
}

const FAKE_DOCKER_PRELOAD = pathToFileURL(path.join(here, 'fake-docker.mjs')).href

/**
 * Install a fake `docker`: a link to the node binary, named `docker`, whose
 * behaviour comes from fake-docker.mjs preloaded via NODE_OPTIONS. It echoes
 * `FAKE-DOCKER <argv>` so tests can assert the exact `docker compose` argv the
 * CLI built, exits with $FAKE_DOCKER_EXIT (default 0) and can be made to write
 * $FAKE_DOCKER_STDERR. See fake-docker.mjs for why it is not a shell script.
 */
function writeFakeDocker(bin: string): void {
  const target = path.join(bin, process.platform === 'win32' ? 'docker.exe' : 'docker')
  try {
    // A hard link is instant; node is ~100MB and this runs per test file.
    linkSync(process.execPath, target)
  } catch {
    try {
      symlinkSync(process.execPath, target)
    } catch {
      // Different volume and no symlink permission: pay for the copy.
      copyFileSync(process.execPath, target)
    }
  }
}

export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'srn-server-test-'))
  const bin = path.join(dir, 'bin')
  const repo = path.join(dir, 'repo')
  // `orphan` must be deep enough that walking up 12 levels still finds no
  // docker-compose.yml — the temp dir root has none, so any depth works.
  const orphan = path.join(dir, 'orphan')
  for (const d of [bin, repo, orphan, path.join(dir, 'empty-bin')]) {
    mkdirSync(d, { recursive: true })
  }
  writeFakeDocker(bin)
  writeFileSync(path.join(repo, 'docker-compose.yml'), 'services:\n  server:\n    image: busybox\n')
  return { dir, repo, orphan, bin }
}

export interface RunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  /** Omit the fake docker from PATH, so spawning `docker` fails with ENOENT. */
  withoutDocker?: boolean
}

/**
 * Windows env vars are case-insensitive but a plain JS object is not: the real
 * variable may be `Path`, so blindly assigning `PATH` would leave the original
 * winning and the fake docker unused. Use whichever key is actually present.
 */
function pathKey(): string {
  return Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
}

/**
 * withoutDocker REPLACES the search path rather than prepending to it: the CI
 * runner has a real docker on PATH, so merely shadowing it would not produce the
 * ENOENT the test is about. node itself is always spawned by absolute path.
 */
function searchPath(sandbox: Sandbox, options: RunOptions): string {
  if (options.withoutDocker) {
    return path.join(sandbox.dir, 'empty-bin')
  }
  return sandbox.bin + path.delimiter + (process.env[pathKey()] ?? '')
}

/** Build the child env. */
function childEnv(sandbox: Sandbox, options: RunOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  env[pathKey()] = searchPath(sandbox, options)
  env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${FAKE_DOCKER_PRELOAD}`.trim()
  // Ambient config must never leak into a test's expectations.
  delete env.SRN_SERVER_URL
  delete env.SHARED_SERVER_ACCESS_KEY
  delete env.SHARED_SERVER_ACCESS_KEY_MODE
  for (const [k, v] of Object.entries(options.env ?? {})) {
    if (v === undefined) {
      delete env[k]
    } else {
      env[k] = v
    }
  }
  return env
}

/**
 * Run the CLI end-to-end. Never rejects; resolves with the captured streams and
 * exit code.
 *
 * Asynchronous on purpose: several tests serve the CLI's health probe from an
 * HTTP server inside THIS process, and spawnSync would block the event loop so
 * that server could never accept the connection.
 */
export function runCli(sandbox: Sandbox, argv: string[], options: RunOptions = {}): Promise<CliResult> {
  // On Windows libuv resolves the executable name against the PARENT process's
  // PATH, not the child env's, so the fake docker is invisible unless this
  // process's own PATH is adjusted for the duration of the spawn call. Lookup
  // happens synchronously inside spawn(), so restoring immediately after is safe
  // (node:test runs the tests in a file sequentially).
  const key = pathKey()
  const savedPath = process.env[key]
  process.env[key] = searchPath(sandbox, options)
  let child
  try {
    child = spawn(process.execPath, ['--import', REGISTER, ENTRY, ...argv], {
      cwd: options.cwd ?? sandbox.orphan,
      // NODE_V8_COVERAGE is inherited through childEnv's spread of process.env;
      // dropping it would silently lose all coverage of the child.
      env: childEnv(sandbox, options),
    })
  } finally {
    process.env[key] = savedPath
  }

  return new Promise<CliResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (stdout += d))
    child.stderr.on('data', (d: string) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stdout.replaceAll('\r\n', '\n'), stderr: stderr.replaceAll('\r\n', '\n') })
    })
  })
}

/** Write a .env fixture into the sandbox and return its path. */
export function writeEnvFile(sandbox: Sandbox, name: string, lines: string[]): string {
  const p = path.join(sandbox.dir, name)
  writeFileSync(p, lines.join('\n') + '\n', 'utf8')
  return p
}

/** A .env in which every required secret is present and well-formed. */
export function healthyEnvLines(): string[] {
  return [
    'AUTH_JWT_SECRET=' + 'a'.repeat(64),
    'AUTH_SERVER_ENCRYPTION_SERVER_KEY=' + 'b'.repeat(64),
    'VALET_TOKEN_SECRET=' + 'c'.repeat(64),
    'WEBSOCKET_GATEWAY_INTERNAL_SECRET=' + 'd'.repeat(64),
    'WEB_SOCKET_CONNECTION_TOKEN_SECRET=' + 'e'.repeat(64),
    'MYSQL_PASSWORD=a-strong-mysql-password',
    'MYSQL_ROOT_PASSWORD=another-strong-password',
  ]
}
