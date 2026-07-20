/**
 * Tests for src/polyfill.ts — the browser-global shims, the X-Shared-Server-Key
 * gate and the persisted cookie jar that keeps a one-shot CLI's session alive.
 *
 * The module installs a global fetch wrapper exactly once and keeps its jar in
 * module scope, so it lives in its own test FILE (node:test runs each file in a
 * separate process) and the ordering of the cases here is deliberate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { type AddressInfo } from 'node:net'
import { configureCookieJar, configureSharedServerKey } from '../src/polyfill.ts'

const workdir = mkdtempSync(path.join(os.tmpdir(), 'srn-polyfill-test-'))

interface Seen {
  url: string
  cookie: string | null
  gate: string | null
}

/** A server that records what it was sent and can set cookies on demand. */
async function startServer(): Promise<{ url: string; seen: Seen[]; stop: () => Promise<void> }> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      cookie: req.headers.cookie ?? null,
      gate: (req.headers['x-shared-server-key'] as string | undefined) ?? null,
    })
    const setCookie = new URL(req.url ?? '/', 'http://x').searchParams.get('set')
    if (setCookie) {
      res.setHeader('Set-Cookie', setCookie.split('|'))
    }
    res.setHeader('content-type', 'application/json')
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('the browser globals snjs reads at load time are all present', () => {
  const g = globalThis as unknown as Record<string, unknown>
  assert.equal(g.self, globalThis)
  assert.equal(g.window, globalThis)
  assert.equal(typeof g.document, 'object')
  // navigator is a real Node global from v21 on, so the shim below it is inert
  // on every supported runtime; all that matters is that something with a
  // userAgent is there when snjs looks.
  assert.equal(typeof (g.navigator as { userAgent: unknown }).userAgent, 'string')
})

test('the noisy TimeoutNegativeWarning is suppressed but other warnings survive', () => {
  const listeners = process.listeners('warning')
  assert.equal(listeners.length, 1, 'the default printer was replaced by exactly one filtered listener')

  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    const benign = new Error('timer fired immediately')
    benign.name = 'TimeoutNegativeWarning'
    listeners[0](benign)
    const real = new Error('something is actually wrong')
    real.name = 'DeprecationWarning'
    listeners[0](real)
  } finally {
    process.stderr.write = original
  }
  assert.deepEqual(written, ['DeprecationWarning: something is actually wrong\n'])
})

test('configureSharedServerKey ignores an empty key and an unparseable URL', async () => {
  const srv = await startServer()
  try {
    configureSharedServerKey(srv.url, undefined)
    configureSharedServerKey(srv.url, '')
    // Must be swallowed, not thrown: there is no origin to scope a key to.
    configureSharedServerKey('::: not a url :::', 'irrelevant')
    await fetch(`${srv.url}/no-key`)
    assert.equal(srv.seen.at(-1)?.gate, null)
  } finally {
    await srv.stop()
  }
})

test('the gate header goes ONLY to the configured origin', async () => {
  const configured = await startServer()
  const other = await startServer()
  try {
    configureSharedServerKey(configured.url, 'gate-key-value')
    await fetch(`${configured.url}/a`)
    await fetch(`${other.url}/a`)
    assert.equal(configured.seen.at(-1)?.gate, 'gate-key-value')
    assert.equal(other.seen.at(-1)?.gate, null, 'the key must never leak to another host')
  } finally {
    await configured.stop()
    await other.stop()
  }
})

test('a caller-supplied gate header is not overwritten', async () => {
  const srv = await startServer()
  try {
    configureSharedServerKey(srv.url, 'gate-key-value')
    await fetch(`${srv.url}/a`, { headers: { 'x-shared-server-key': 'caller-set' } })
    assert.equal(srv.seen.at(-1)?.gate, 'caller-set')
  } finally {
    await srv.stop()
  }
})

test('cookies are persisted to disk with restrictive intent and replayed', async () => {
  const srv = await startServer()
  const jarFile = path.join(workdir, 'jar-replay.json')
  try {
    configureCookieJar(jarFile)
    await fetch(`${srv.url}/login?set=${encodeURIComponent('sess=abc123; HttpOnly; Path=/|other=zzz')}`)
    assert.equal(srv.seen.at(-1)?.cookie, null, 'the first request has nothing to replay')

    const onDisk = JSON.parse(readFileSync(jarFile, 'utf8')) as Record<string, Record<string, string>>
    assert.deepEqual(onDisk[new URL(srv.url).origin], { sess: 'abc123', other: 'zzz' })

    await fetch(`${srv.url}/next`)
    assert.equal(srv.seen.at(-1)?.cookie, 'sess=abc123; other=zzz')
  } finally {
    await srv.stop()
  }
})

test('cookies are scoped per origin and never replay to another host', async () => {
  const a = await startServer()
  const b = await startServer()
  try {
    configureCookieJar(path.join(workdir, 'jar-scope.json'))
    await fetch(`${a.url}/login?set=${encodeURIComponent('sess=from-a')}`)
    await fetch(`${b.url}/anything`)
    assert.equal(b.seen.at(-1)?.cookie, null)
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('an explicit cookie header on the request wins over the jar', async () => {
  const srv = await startServer()
  try {
    configureCookieJar(path.join(workdir, 'jar-explicit.json'))
    await fetch(`${srv.url}/login?set=${encodeURIComponent('sess=jarvalue')}`)
    await fetch(`${srv.url}/next`, { headers: { cookie: 'mine=1' } })
    assert.equal(srv.seen.at(-1)?.cookie, 'mine=1')
  } finally {
    await srv.stop()
  }
})

test('a cleared session cookie is honoured rather than replayed forever', async () => {
  const srv = await startServer()
  try {
    configureCookieJar(path.join(workdir, 'jar-delete.json'))
    await fetch(`${srv.url}/login?set=${encodeURIComponent('sess=abc|keep=yes')}`)
    // Empty value = deletion, which is how a logout clears the session cookie.
    await fetch(`${srv.url}/logout?set=${encodeURIComponent('sess=; Path=/')}`)
    await fetch(`${srv.url}/next`)
    assert.equal(srv.seen.at(-1)?.cookie, 'keep=yes')
  } finally {
    await srv.stop()
  }
})

test('Max-Age=0 and a past Expires both delete, a future one does not', async () => {
  const srv = await startServer()
  try {
    configureCookieJar(path.join(workdir, 'jar-expiry.json'))
    const past = new Date(Date.now() - 60_000).toUTCString()
    const future = new Date(Date.now() + 600_000).toUTCString()
    await fetch(`${srv.url}/login?set=${encodeURIComponent('a=1|b=2|c=3')}`)
    await fetch(
      `${srv.url}/expire?set=${encodeURIComponent(`a=1; Max-Age=0|b=2; Expires=${past}|c=3; Expires=${future}`)}`,
    )
    await fetch(`${srv.url}/next`)
    assert.equal(srv.seen.at(-1)?.cookie, 'c=3')
  } finally {
    await srv.stop()
  }
})

test('an unparseable Max-Age or Expires is ignored, not treated as a deletion', async () => {
  const srv = await startServer()
  try {
    configureCookieJar(path.join(workdir, 'jar-badattr.json'))
    await fetch(`${srv.url}/login?set=${encodeURIComponent('a=1; Max-Age=soon|b=2; Expires=never')}`)
    await fetch(`${srv.url}/next`)
    assert.equal(srv.seen.at(-1)?.cookie, 'a=1; b=2')
  } finally {
    await srv.stop()
  }
})

test('a Set-Cookie with no "=" is skipped without losing the valid ones', async () => {
  const srv = await startServer()
  try {
    configureCookieJar(path.join(workdir, 'jar-malformed.json'))
    await fetch(`${srv.url}/login?set=${encodeURIComponent('novalue|=leadingequals|ok=1')}`)
    await fetch(`${srv.url}/next`)
    assert.equal(srv.seen.at(-1)?.cookie, 'ok=1')
  } finally {
    await srv.stop()
  }
})

test('a previously saved jar is restored on the next invocation', async () => {
  const srv = await startServer()
  const jarFile = path.join(workdir, 'jar-restore.json')
  writeFileSync(jarFile, JSON.stringify({ [new URL(srv.url).origin]: { restored: 'yes' } }))
  try {
    configureCookieJar(jarFile)
    await fetch(`${srv.url}/next`)
    assert.equal(srv.seen.at(-1)?.cookie, 'restored=yes')
  } finally {
    await srv.stop()
  }
})

test('a missing or corrupt jar file starts empty instead of throwing', async () => {
  const corrupt = path.join(workdir, 'jar-corrupt.json')
  writeFileSync(corrupt, 'this is not json')
  assert.doesNotThrow(() => configureCookieJar(path.join(workdir, 'never-written.json')))
  assert.doesNotThrow(() => configureCookieJar(corrupt))

  const srv = await startServer()
  try {
    await fetch(`${srv.url}/next`)
    assert.equal(srv.seen.at(-1)?.cookie, null)
  } finally {
    await srv.stop()
  }
})

test('an unpersistable jar path degrades to in-memory rather than failing the request', async () => {
  const srv = await startServer()
  try {
    // A directory can never be opened for writing as a file.
    configureCookieJar(workdir)
    const res = await fetch(`${srv.url}/login?set=${encodeURIComponent('sess=inmemory')}`)
    assert.equal(res.status, 200)
    await fetch(`${srv.url}/next`)
    assert.equal(srv.seen.at(-1)?.cookie, 'sess=inmemory')
  } finally {
    await srv.stop()
  }
})

test('a request to an unparseable URL is passed through without a jar lookup', async () => {
  // originOf() must swallow the URL parse failure; fetch itself then rejects.
  await assert.rejects(() => fetch('not-a-valid-url'))
})
