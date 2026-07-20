/**
 * Test harness for end-to-end runs of `src/index.ts`.
 *
 * index.ts calls `main()` at import time, so it cannot be imported. It is
 * instead executed as a child process with the ./x.js -> ./x.ts resolver, so the
 * child runs the real TypeScript sources — V8 coverage from the child is merged
 * by `node --test`, which is what makes the entry point measurable at all.
 *
 * Every run gets a THROWAWAY $SRN_HOME, so the real ~/.srn keychain is never
 * read, written or deleted by a test.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

export interface Sandbox {
  dir: string
  /** Value used for $SRN_HOME; never the real ~/.srn. */
  home: string
}

export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'srn-client-test-'))
  const home = path.join(dir, 'srn-home')
  mkdirSync(home, { recursive: true })
  return { dir, home }
}

export interface RunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
}

/**
 * Run the CLI end-to-end. Never rejects; resolves with the captured streams and
 * exit code. Asynchronous so tests can serve HTTP to the child from within this
 * process (spawnSync would deadlock against its own event loop).
 */
export function runCli(sandbox: Sandbox, argv: string[], options: RunOptions = {}): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // Ambient config must never leak into a test's expectations, and a developer's
  // real server/credentials must never be reachable from a test.
  delete env.SRN_SERVER_URL
  delete env.SRN_PASSWORD
  delete env.SHARED_SERVER_ACCESS_KEY
  delete env.SRN_DEBUG
  env.SRN_HOME = sandbox.home
  for (const [k, v] of Object.entries(options.env ?? {})) {
    if (v === undefined) {
      delete env[k]
    } else {
      env[k] = v
    }
  }

  const child = spawn(process.execPath, ['--import', REGISTER, ENTRY, ...argv], {
    cwd: options.cwd ?? sandbox.dir,
    // NODE_V8_COVERAGE rides along in this spread; dropping it would silently
    // lose all coverage of the child.
    env,
  })

  return new Promise<CliResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (stdout += d))
    child.stderr.on('data', (d: string) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stdout.replaceAll('\r\n', '\n'), stderr: stderr.replaceAll('\r\n', '\n') })
    })
  })
}

/** Write a fixture file into the sandbox and return its absolute path. */
export function writeFixture(sandbox: Sandbox, name: string, content: string): string {
  const p = path.join(sandbox.dir, name)
  writeFileSync(p, content, 'utf8')
  return p
}
