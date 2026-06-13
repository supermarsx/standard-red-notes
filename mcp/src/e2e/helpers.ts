import '../polyfill.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootstrapHeadlessApp, type HeadlessApp } from '../snjs/bootstrap.js'

export const SERVER = process.env.STANDARD_RED_NOTES_SERVER_URL ?? 'http://localhost:3000'
export const GATEWAY_HTTP = process.env.GATEWAY_HTTP ?? 'http://localhost:3106'
export const GATEWAY_WS = process.env.GATEWAY_WS ?? 'ws://localhost:3106'
export const INTERNAL_SECRET =
  process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ?? 'dev-ws-internal-secret-change-me'

let failures = 0
export function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   - ${name}`)
  } else {
    console.log(`  FAIL - ${name}`)
    failures++
  }
}
export function finish(): never {
  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

export async function serverUp(): Promise<boolean> {
  const code = await fetch(`${SERVER}/healthcheck`)
    .then((r) => r.status)
    .catch(() => 0)
  return code === 200
}

/** Bootstrap + register a fresh throwaway account in a temp data dir. */
export async function freshAccount(): Promise<{ app: HeadlessApp; email: string; password: string; dataDir: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-e2e-'))
  const stamp = Date.now() + '-' + Math.floor(performance.now())
  const email = `e2e-${stamp}@example.com`
  const password = `pw-${stamp}-correcthorse`
  const app = await bootstrapHeadlessApp({ serverUrl: SERVER, dataDir, password, syncIntervalMs: 0 })
  // Register has an occasional transient challenge; retry a couple of times.
  let lastErr: unknown
  for (let i = 0; i < 3; i++) {
    try {
      await app.register(email, password)
      return { app, email, password, dataDir }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

export async function cleanup(app: HeadlessApp, dataDir: string): Promise<void> {
  await app.deinit()
  await fs.rm(dataDir, { recursive: true, force: true })
}
