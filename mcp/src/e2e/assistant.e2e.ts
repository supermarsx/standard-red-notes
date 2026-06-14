// Endpoint integration e2e for the assistant config fix: GET /v1/assistant/config
// must be PUBLIC (it returned 401 before the fix, which broke the web client),
// while POST /v1/assistant/stream must stay AUTH-PROTECTED.
//
// Standalone on purpose: it only needs fetch, so it does NOT import the snjs
// helpers/polyfill (loading libsodium then process.exit trips a libuv assertion
// on Windows). Keep it dependency-free.

const SERVER = process.env.STANDARD_RED_NOTES_SERVER_URL ?? 'http://localhost:3000'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ok   - ${name}`)
  else {
    console.log(`  FAIL - ${name}`)
    failures++
  }
}

async function main(): Promise<void> {
  // `connection: close` so undici doesn't keep a socket alive (a lingering
  // keep-alive handle + process exit trips a libuv assertion on Node/Windows).
  const noKeepAlive = { headers: { connection: 'close' } as Record<string, string> }

  const up = await fetch(`${SERVER}/healthcheck`, noKeepAlive).then((r) => r.status === 200).catch(() => false)
  if (!up) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exitCode = 0
    return
  }

  // Public config endpoint — no auth header — must NOT 401/403.
  const cfg = await fetch(`${SERVER}/v1/assistant/config`, { method: 'GET', ...noKeepAlive })
  await cfg.text()
  check('GET /v1/assistant/config is reachable without auth (not 401/403)', cfg.status !== 401 && cfg.status !== 403)
  check('GET /v1/assistant/config returns success', cfg.status === 200)

  // Protected stream endpoint — no auth — must be rejected.
  const stream = await fetch(`${SERVER}/v1/assistant/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ messages: [] }),
  })
  await stream.text()
  check('POST /v1/assistant/stream requires auth (401/403)', stream.status === 401 || stream.status === 403)

  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
  // Let the event loop drain and exit naturally (no abrupt process.exit).
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
