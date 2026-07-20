// MUST come first, exactly as in src/index.ts: snjs's published bundle reads the
// browser global `self` at module-evaluation time.
import '../src/polyfill.ts'

/**
 * Tests for src/bootstrap.ts — booting a real headless snjs Application against
 * a throwaway data dir.
 *
 * A genuine SNApplication is constructed and launched here; only the network is
 * absent. That covers construction, the launch handshake, the offline shape of
 * the returned HeadlessApp and the two authentication error paths.
 *
 * NOT covered, and not fakeable honestly: everything past a successful
 * register/signIn. Those need a live Standard Notes server and a real
 * end-to-end-encrypted account.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdtempSync } from 'node:fs'
import { bootstrapHeadlessApp, type HeadlessApp } from '../src/bootstrap.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'srn-bootstrap-test-'))
let counter = 0

// Port 1 is reserved and never listening, so every request fails fast without
// leaving this machine.
const DEAD_SERVER = 'http://127.0.0.1:1'

async function boot(options: { serverKey?: string; password?: string; mfaCode?: string } = {}): Promise<{
  headless: HeadlessApp
  dataDir: string
}> {
  const dataDir = path.join(root, `d${counter++}`)
  const headless = await bootstrapHeadlessApp({ serverUrl: DEAD_SERVER, dataDir, ...options })
  return { headless, dataDir }
}

test('bootstrapping creates the data dir and returns a usable headless app', async () => {
  const { headless, dataDir } = await boot()
  try {
    assert.ok(existsSync(dataDir), 'the data dir must exist before snjs writes keys into it')
    assert.equal(typeof headless.app, 'object')
    assert.equal(typeof headless.sync, 'function')
  } finally {
    await headless.deinit()
  }
})

test('a freshly bootstrapped app has no account and no user', async () => {
  const { headless } = await boot()
  try {
    assert.equal(headless.isSignedIn(), false)
    assert.equal(headless.getUser(), undefined)
  } finally {
    await headless.deinit()
  }
})

test('bootstrapping twice against the same data dir is safe', async () => {
  const dataDir = path.join(root, `shared${counter++}`)
  const first = await bootstrapHeadlessApp({ serverUrl: DEAD_SERVER, dataDir })
  await first.deinit()
  const second = await bootstrapHeadlessApp({ serverUrl: DEAD_SERVER, dataDir })
  try {
    assert.equal(second.isSignedIn(), false)
  } finally {
    await second.deinit()
  }
})

test('a distinct identifier can be supplied for the snjs namespace', async () => {
  const dataDir = path.join(root, `ident${counter++}`)
  const headless = await bootstrapHeadlessApp({ serverUrl: DEAD_SERVER, dataDir, identifier: 'other-app' })
  try {
    assert.equal(headless.isSignedIn(), false)
  } finally {
    await headless.deinit()
  }
})

test('signIn against an unreachable server reports a sign-in failure', async () => {
  const { headless } = await boot()
  try {
    await assert.rejects(() => headless.signIn('nobody@example.com', 'pw'), /sign-in failed: /)
  } finally {
    await headless.deinit()
  }
})

test('signIn never puts the password in the error message', async () => {
  const { headless } = await boot()
  try {
    const err = await headless.signIn('nobody@example.com', 'correct-horse-battery-staple').catch((e: Error) => e)
    assert.ok(err instanceof Error)
    assert.doesNotMatch(err.message, /correct-horse-battery-staple/)
  } finally {
    await headless.deinit()
  }
})

test('a static --mfa code skips the magic-link pre-fetch', async () => {
  // With a code in hand there is nothing to pre-fetch; the call must still fail
  // at the network rather than hanging or throwing something unrelated.
  const { headless } = await boot({ mfaCode: '123456' })
  try {
    await assert.rejects(() => headless.signIn('nobody@example.com', 'pw', '123456'), /sign-in failed: /)
  } finally {
    await headless.deinit()
  }
})

test('register against an unreachable server reports a register failure', async () => {
  const { headless } = await boot()
  try {
    await assert.rejects(
      () => headless.register('nobody@example.com', 'a-sufficiently-long-passphrase'),
      /register failed: |fetch failed/,
    )
  } finally {
    await headless.deinit()
  }
})

test('register enforces the account password policy before any network call', async () => {
  const { headless } = await boot()
  try {
    await assert.rejects(() => headless.register('nobody@example.com', 'short'), /at least 8 characters/)
  } finally {
    await headless.deinit()
  }
})

test('deinit can be called twice the way cmdLogin does, without crashing', async () => {
  // index.ts deinits in both the catch and the finally of cmdLogin, each guarded
  // by .catch(() => {}). This pins that the guarded double-deinit is survivable.
  const { headless } = await boot()
  await headless.deinit().catch(() => {})
  await headless.deinit().catch(() => {})
})

test('SRN_DEBUG routes snjs errors to stderr instead of swallowing them', async () => {
  const previous = process.env.SRN_DEBUG
  process.env.SRN_DEBUG = '1'
  const written: string[] = []
  const originalError = console.error
  // eslint-disable-next-line no-console
  console.error = ((...args: unknown[]) => {
    written.push(args.map(String).join(' '))
  }) as typeof console.error
  try {
    const snjs = (await import('@standardnotes/snjs')) as unknown as { default: Record<string, any> }
    const SNLog = (snjs.default ?? snjs).SNLog as { onError: (...a: unknown[]) => void }
    SNLog.onError(new Error('boom'))
    assert.equal(written.length, 1)
    assert.match(written[0], /\[snjs\].*boom/)
  } finally {
    console.error = originalError
    if (previous === undefined) {
      delete process.env.SRN_DEBUG
    } else {
      process.env.SRN_DEBUG = previous
    }
  }
})

test('snjs errors are silent without SRN_DEBUG', async () => {
  const previous = process.env.SRN_DEBUG
  delete process.env.SRN_DEBUG
  const written: string[] = []
  const originalError = console.error
  // eslint-disable-next-line no-console
  console.error = ((...args: unknown[]) => {
    written.push(args.map(String).join(' '))
  }) as typeof console.error
  try {
    const snjs = (await import('@standardnotes/snjs')) as unknown as { default: Record<string, any> }
    const SNLog = (snjs.default ?? snjs).SNLog as {
      onError: (...a: unknown[]) => void
      onLog: (...a: unknown[]) => void
    }
    SNLog.onError(new Error('boom'))
    SNLog.onLog('chatter')
    assert.deepEqual(written, [], 'CLI output must stay clean by default')
  } finally {
    console.error = originalError
    if (previous !== undefined) {
      process.env.SRN_DEBUG = previous
    }
  }
})

test('the SUMO shim refuses to run crypto before libsodium is ready', async () => {
  // The shim's whole reason to exist is that a static re-export would snapshot
  // `undefined`; if a member is genuinely missing it must say so loudly rather
  // than silently doing nothing with key material.
  const shim = (await import('../src/libsodium-sumo-shim.mjs')) as unknown as Record<string, unknown>
  const sodium = (await import('libsodium-wrappers-sumo')).default as Record<string, unknown>
  const original = sodium.crypto_pwhash
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(sodium as any).crypto_pwhash = undefined
  try {
    assert.throws(
      () => (shim.crypto_pwhash as (...a: unknown[]) => unknown)(),
      /libsodium: crypto_pwhash unavailable; await ready before calling crypto\./,
    )
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sodium as any).crypto_pwhash = original
  }
})

test('the SUMO shim reads members off sodium at CALL time, not at import time', async () => {
  const shim = (await import('../src/libsodium-sumo-shim.mjs')) as unknown as Record<string, unknown>
  const sodium = (await import('libsodium-wrappers-sumo')).default as Record<string, unknown>
  await (sodium.ready as Promise<void>)
  const original = sodium.to_hex
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(sodium as any).to_hex = () => 'swapped-at-runtime'
  try {
    assert.equal((shim.to_hex as (...a: unknown[]) => unknown)(new Uint8Array([1])), 'swapped-at-runtime')
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sodium as any).to_hex = original
  }
})
