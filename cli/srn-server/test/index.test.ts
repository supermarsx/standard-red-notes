/**
 * End-to-end tests for src/index.ts — the srn-server entry point.
 *
 * These run the real entry as a child process (see harness.ts) so dispatch,
 * repo-root discovery, the docker-compose spawn wrapper, HTTP probing and the
 * `config` validator are all exercised as a user would hit them. No test can
 * reach a real docker daemon (fake `docker` first on PATH) or the real repo.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { type AddressInfo } from 'node:net'
import { healthyEnvLines, makeSandbox, runCli, splitNodeNotices, writeEnvFile, type Sandbox } from './harness.ts'

const sandbox: Sandbox = makeSandbox()

/** Start a throwaway HTTP server; returns its base URL and a stop function. */
async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; requests: http.IncomingHttpHeaders[]; stop: () => Promise<void> }> {
  const requests: http.IncomingHttpHeaders[] = []
  const server = http.createServer((req, res) => {
    requests.push(req.headers)
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// --- harness: Node's own notices must not be mistaken for CLI output ---------

test("Node's process-level notices are split out of the CLI's stderr", () => {
  // Regression guard. The child runs with `--import <resolver>`; when Node
  // complains about that plumbing the notice landed in stderr and every test
  // asserting exact CLI stderr went red on the Node 26 runner while passing on
  // Node 24. This is the verbatim output that broke it.
  const raw =
    '(node:2468) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.\n' +
    '(Use `node --trace-deprecation ...` to show where the warning was created)\n' +
    'Error: Could not locate the repo root.\n'
  const split = splitNodeNotices(raw)
  assert.equal(split.stderr, 'Error: Could not locate the repo root.\n')
  assert.equal(split.nodeNotices.length, 2, 'the warning AND its paired hint line are both taken')
  assert.match(split.nodeNotices[0], /DEP0205/)
})

test('splitting notices leaves ordinary stderr completely untouched', () => {
  const raw = 'Error: something broke\nsecond line (node:123) not at the start\n'
  assert.deepEqual(splitNodeNotices(raw), { stderr: raw, nodeNotices: [] })
})

test('a CLI line that merely mentions a warning is NOT swallowed', () => {
  // Only Node's own `(node:PID) ` prefix format is filtered.
  const raw = 'DeprecationWarning: this came from the CLI itself\n'
  assert.deepEqual(splitNodeNotices(raw), { stderr: raw, nodeNotices: [] })
})

test('a REAL Node notice on a real child is split out, end to end', async () => {
  // Proves the splitting against Node's actual printer, not a hand-written
  // string. Overriding NODE_OPTIONS drops the fake-docker preload, so this uses
  // a command that never spawns docker.
  const preload = pathToFileURL(path.join(import.meta.dirname, 'emit-warning.mjs')).href
  const r = await runCli(sandbox, ['version', '--url', 'http://127.0.0.1:1', '--timeout', '300'], {
    env: { NODE_OPTIONS: `--import ${preload}` },
  })
  assert.equal(r.code, 0)
  assert.ok(
    r.nodeNotices.some((n) => n.includes('HarnessTestWarning')),
    `expected the notice to be captured, got ${JSON.stringify(r.nodeNotices)}`,
  )
  assert.doesNotMatch(r.stderr, /HarnessTestWarning/, 'it must not contaminate the CLI stderr')
  assert.doesNotMatch(r.stderr, /^\(node:\d+\)/m)
  // Second layer: the child runs with --no-deprecation, so a DeprecationWarning
  // is never emitted at all — not into stderr and not into nodeNotices.
  assert.doesNotMatch(r.stderr, /DeprecationWarning/)
  assert.equal(
    r.nodeNotices.some((n) => n.includes('DeprecationWarning')),
    false,
  )
})

// --- help / dispatch ---------------------------------------------------------

test('bare invocation prints HELP and exits 0', async () => {
  const r = await runCli(sandbox, [])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /srn-server 0\.1\.0 — operational CLI/)
  assert.match(r.stdout, /COMMANDS/)
  assert.equal(r.stderr, '')
})

test('`help` and --help and -h all print HELP and exit 0', async () => {
  for (const argv of [['help'], ['--help'], ['-h']]) {
    const r = await runCli(sandbox, argv)
    assert.equal(r.code, 0, `argv ${argv.join(' ')}`)
    assert.match(r.stdout, /USAGE\n {2}srn-server <command> \[options]/)
  }
})

test('--help on a real command short-circuits that command and exits 0', async () => {
  // `down --help` must print help, NOT refuse-to-run text, and must not exit 2.
  const r = await runCli(sandbox, ['down', '--help'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /COMMANDS/)
  assert.doesNotMatch(r.stderr, /Refusing/)
})

test('an unknown command reports it on stderr, prints HELP and exits 1', async () => {
  const r = await runCli(sandbox, ['frobnicate'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^Unknown command: frobnicate\n/)
  assert.match(r.stderr, /COMMANDS/)
  assert.equal(r.stdout, '')
})

test('version prints the CLI version before probing the server', async () => {
  const r = await runCli(sandbox, ['version', '--url', 'http://127.0.0.1:1', '--timeout', '300'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /^srn-server 0\.1\.0\n/)
  assert.match(r.stdout, /unreachable/)
})

test('version reports a reachable server without leaking the shared key', async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(200).end('ok')
  })
  try {
    const r = await runCli(sandbox, ['version', '--url', srv.url, '--server-key', 'super-secret-key'])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /200 reachable/)
    assert.equal(srv.requests[0]['x-shared-server-key'], 'super-secret-key')
    // The gate key must never be echoed back to the operator's terminal.
    assert.doesNotMatch(r.stdout + r.stderr, /super-secret-key/)
  } finally {
    await srv.stop()
  }
})

test('version reports a non-2xx server as an error, still exiting 0', async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(503).end('nope')
  })
  try {
    const r = await runCli(sandbox, ['version', '--url', srv.url])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /503 error/)
  } finally {
    await srv.stop()
  }
})

// --- health ------------------------------------------------------------------

test('health against a healthy server prints ok and exits 0', async () => {
  const srv = await startServer((req, res) => {
    assert.equal(req.url, '/healthcheck')
    res.writeHead(200).end('all good')
  })
  try {
    const r = await runCli(sandbox, ['health', '--url', srv.url])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /Health probe against http:\/\/127\.0\.0\.1:\d+\n/)
    // Name column is padEnd(22), 'api-gateway (server)' is 20 chars, plus the
    // single separator space before the status.
    assert.match(r.stdout, /^ {2}ok {3}api-gateway \(server\) {3}200 all good$/m)
  } finally {
    await srv.stop()
  }
})

test('health sends NO gate header when no key is configured', async () => {
  const srv = await startServer((_req, res) => res.writeHead(200).end('ok'))
  try {
    await runCli(sandbox, ['health', '--url', srv.url])
    assert.equal('x-shared-server-key' in srv.requests[0], false)
  } finally {
    await srv.stop()
  }
})

test('health takes the gate key from $SHARED_SERVER_ACCESS_KEY', async () => {
  const srv = await startServer((_req, res) => res.writeHead(200).end('ok'))
  try {
    const r = await runCli(sandbox, ['health', '--url', srv.url], { env: { SHARED_SERVER_ACCESS_KEY: 'env-key' } })
    assert.equal(r.code, 0)
    assert.equal(srv.requests[0]['x-shared-server-key'], 'env-key')
  } finally {
    await srv.stop()
  }
})

test('health against a failing server prints FAIL and exits 1', async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(500).end('boom')
  })
  try {
    const r = await runCli(sandbox, ['health', '--url', srv.url])
    assert.equal(r.code, 1)
    assert.match(r.stdout, /^ {2}FAIL /m)
    assert.match(r.stdout, /500 boom/)
  } finally {
    await srv.stop()
  }
})

test('health truncates a huge response body to 80 characters', async () => {
  const srv = await startServer((_req, res) => res.writeHead(200).end('x'.repeat(500)))
  try {
    const r = await runCli(sandbox, ['health', '--url', srv.url])
    const line = r.stdout.split('\n').find((l) => l.startsWith('  ok'))!
    const body = line.slice(line.indexOf('200 ') + 4)
    assert.equal(body.length, 80)
  } finally {
    await srv.stop()
  }
})

test('health on a closed port prints DOWN and exits 1', async () => {
  const r = await runCli(sandbox, ['health', '--url', 'http://127.0.0.1:1', '--timeout', '2000'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /^ {2}DOWN /m)
  assert.doesNotMatch(r.stdout, /timeout/)
})

test('health reports `timeout` (not a socket error) when the probe deadline passes', async () => {
  // Never responds, so only the AbortController can end the request.
  const srv = await startServer(() => {})
  try {
    const r = await runCli(sandbox, ['health', '--url', srv.url, '--timeout', '250'])
    assert.equal(r.code, 1)
    assert.match(r.stdout, /^ {2}DOWN .*timeout$/m)
  } finally {
    await srv.stop()
  }
})

test('health tolerates a trailing slash on --url instead of doubling it', async () => {
  const seen: string[] = []
  const srv = await startServer((req, res) => {
    seen.push(req.url ?? '')
    res.writeHead(200).end('ok')
  })
  try {
    const r = await runCli(sandbox, ['health', '--url', srv.url + '/'])
    assert.equal(r.code, 0)
    assert.deepEqual(seen, ['/healthcheck'])
  } finally {
    await srv.stop()
  }
})

test('health defaults to loopback, so a bare `health` never probes a remote host', async () => {
  const r = await runCli(sandbox, ['health', '--timeout', '300'])
  assert.match(r.stdout, /^Health probe against http:\/\/localhost:3001\n/)
})

// --- repo root discovery -----------------------------------------------------

test('status walks up from the cwd to find the repo root', async () => {
  const nested = path.join(sandbox.repo, 'a', 'b', 'c')
  mkdirSync(nested, { recursive: true })
  const r = await runCli(sandbox, ['status'], { cwd: nested })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /FAKE-DOCKER compose ps/)
})

test('a missing repo root is a clear error, exit 1, with no docker invoked', async () => {
  const r = await runCli(sandbox, ['status'], { cwd: sandbox.orphan })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^Error: Could not locate the repo root/)
  assert.match(r.stderr, /pass --repo <path-to-repo>/)
  assert.doesNotMatch(r.stdout, /FAKE-DOCKER/)
})

test('--repo overrides discovery even when the cwd IS a repo root', async () => {
  const other = path.join(sandbox.dir, 'other-repo')
  mkdirSync(other, { recursive: true })
  writeFileSync(path.join(other, 'docker-compose.yml'), 'services: {}\n')
  const r = await runCli(sandbox, ['status', '--repo', other], { cwd: sandbox.repo })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /FAKE-DOCKER compose ps/)
})

// --- docker compose wrapping -------------------------------------------------

test('up always runs detached and echoes the exact command', async () => {
  const r = await runCli(sandbox, ['up', '--repo', sandbox.repo])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /^Starting stack: docker compose up -d \(cwd /m)
  assert.match(r.stdout, /FAKE-DOCKER compose up -d\s*$/m)
})

test('up --build keeps the service name it precedes', async () => {
  const r = await runCli(sandbox, ['up', '--build', 'server', '--repo', sandbox.repo])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /FAKE-DOCKER compose up -d --build server/)
})

test('logs -f server passes BOTH the follow flag and the service', async () => {
  const r = await runCli(sandbox, ['logs', '-f', 'server', '--repo', sandbox.repo])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /FAKE-DOCKER compose logs -f server/)
})

test('logs --tail emits the count as a separate argv entry', async () => {
  const r = await runCli(sandbox, ['logs', '--tail', '50', 'server', '--repo', sandbox.repo])
  assert.match(r.stdout, /FAKE-DOCKER compose logs --tail 50 server/)
})

test('down without --yes refuses, exits 2 and never spawns docker', async () => {
  const r = await runCli(sandbox, ['down', '--repo', sandbox.repo])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /Refusing to run `docker compose down` without explicit confirmation/)
  assert.doesNotMatch(r.stdout, /FAKE-DOCKER/)
})

test('down --yes stops the stack but does NOT imply --volumes', async () => {
  const r = await runCli(sandbox, ['down', '--yes', '--repo', sandbox.repo])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /FAKE-DOCKER compose down\s*$/m)
  assert.doesNotMatch(r.stdout, /--volumes/)
})

test('down --yes --volumes opts in to data destruction explicitly', async () => {
  const r = await runCli(sandbox, ['down', '--yes', '--volumes', '--repo', sandbox.repo])
  assert.match(r.stdout, /FAKE-DOCKER compose down --volumes/)
})

test("docker's exit code is propagated as the CLI's exit code", async () => {
  const r = await runCli(sandbox, ['status', '--repo', sandbox.repo], { env: { FAKE_DOCKER_EXIT: '7' } })
  assert.equal(r.code, 7)
})

test('a missing docker binary exits 127 with an actionable hint', async () => {
  const r = await runCli(sandbox, ['status', '--repo', sandbox.repo], { withoutDocker: true })
  assert.equal(r.code, 127)
  assert.match(r.stderr, /Failed to run `docker`/)
  assert.match(r.stderr, /Is Docker installed and on your PATH\?/)
})

// --- config ------------------------------------------------------------------

test('config with no .env warns, points at setup and exits 1', async () => {
  const r = await runCli(sandbox, ['config', '--repo', sandbox.orphan, '--env', path.join(sandbox.dir, 'absent.env')])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /No \.env found\./)
  assert.match(r.stdout, /scripts\/setup\.sh/)
  // With no .env every required key is reported missing.
  assert.equal(r.stdout.match(/^ {2}MISSING {2}/gm)?.length, 7)
})

test('config with a healthy .env reports every secret ok and exits 0', async () => {
  const envPath = writeEnvFile(sandbox, 'healthy.env', healthyEnvLines())
  const r = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /\nConfig looks good\.\n$/)
  assert.equal(r.stdout.match(/^ {2}ok {7}/gm)?.length, 7)
  assert.match(r.stdout, /ok {7}AUTH_JWT_SECRET \(set, 64 chars\)/)
})

test('config NEVER prints a secret value', async () => {
  const secret = 'f'.repeat(64)
  const envPath = writeEnvFile(sandbox, 'secretcheck.env', [
    ...healthyEnvLines().filter((l) => !l.startsWith('AUTH_JWT_SECRET=')),
    'AUTH_JWT_SECRET=' + secret,
    'MYSQL_PASSWORD=hunter2-plaintext-password',
  ])
  const r = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath])
  assert.equal(r.code, 0)
  assert.doesNotMatch(r.stdout + r.stderr, /f{64}/)
  assert.doesNotMatch(r.stdout + r.stderr, /hunter2-plaintext-password/)
})

test('config flags CHANGE-ME placeholders, short keys and missing keys separately', async () => {
  const envPath = writeEnvFile(sandbox, 'broken.env', [
    'AUTH_JWT_SECRET=CHANGE-ME-please-replace-this-value-now-really-do-it-ok-fine!',
    'AUTH_SERVER_ENCRYPTION_SERVER_KEY=tooshort',
    'VALET_TOKEN_SECRET=' + 'c'.repeat(64),
    'WEBSOCKET_GATEWAY_INTERNAL_SECRET=' + 'd'.repeat(64),
    'WEB_SOCKET_CONNECTION_TOKEN_SECRET=' + 'e'.repeat(64),
    'MYSQL_PASSWORD=fine',
    '# MYSQL_ROOT_PASSWORD is commented out on purpose',
  ])
  const r = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /PLACEHOLDER AUTH_JWT_SECRET \(still contains CHANGE-ME/)
  assert.match(r.stdout, /WEAK {5}AUTH_SERVER_ENCRYPTION_SERVER_KEY/)
  assert.match(r.stdout, /MISSING {2}MYSQL_ROOT_PASSWORD \(will use insecure compose default\)/)
  assert.match(r.stdout, /\n3 config issue\(s\) found\.\n/)
})

test('a placeholder is reported as such even at a valid 64-char hex-ish length', async () => {
  // Ordering matters: the CHANGE-ME check must run BEFORE the hex-shape check,
  // otherwise a 64-char placeholder would be misreported as merely "weak".
  const envPath = writeEnvFile(sandbox, 'placeholder64.env', [
    ...healthyEnvLines().filter((l) => !l.startsWith('VALET_TOKEN_SECRET=')),
    'VALET_TOKEN_SECRET=changeme' + 'a'.repeat(56),
  ])
  const r = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath])
  assert.match(r.stdout, /PLACEHOLDER VALET_TOKEN_SECRET/)
  assert.doesNotMatch(r.stdout, /WEAK {5}VALET_TOKEN_SECRET/)
})

test('the process environment wins over the .env file, as docker compose does', async () => {
  const envPath = writeEnvFile(sandbox, 'weakjwt.env', [
    ...healthyEnvLines().filter((l) => !l.startsWith('AUTH_JWT_SECRET=')),
    'AUTH_JWT_SECRET=nope',
  ])
  const withoutOverride = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath])
  assert.match(withoutOverride.stdout, /WEAK {5}AUTH_JWT_SECRET/)

  const withOverride = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath], {
    env: { AUTH_JWT_SECRET: '0'.repeat(64) },
  })
  assert.equal(withOverride.code, 0)
  assert.match(withOverride.stdout, /ok {7}AUTH_JWT_SECRET/)
})

test('config reports the shared-key gate as off when no key is set', async () => {
  const envPath = writeEnvFile(sandbox, 'nogate.env', healthyEnvLines())
  const r = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath])
  assert.match(r.stdout, /^ {2}off {6}\(no SHARED_SERVER_ACCESS_KEY set; gate disabled\)$/m)
})

test('config reports the gate as enabled with its mode, never its key', async () => {
  const envPath = writeEnvFile(sandbox, 'gate.env', [
    ...healthyEnvLines(),
    'SHARED_SERVER_ACCESS_KEY=the-gate-key-value',
    'SHARED_SERVER_ACCESS_KEY_MODE=strict',
  ])
  const r = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath])
  assert.match(r.stdout, /^ {2}enabled {2}mode=strict \(clients must send X-Shared-Server-Key\)$/m)
  assert.doesNotMatch(r.stdout, /the-gate-key-value/)
})

test('the gate mode defaults to `all` when only a key is set', async () => {
  const envPath = writeEnvFile(sandbox, 'gate-default.env', [...healthyEnvLines(), 'SHARED_SERVER_ACCESS_KEY=k'])
  const r = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath])
  assert.match(r.stdout, /enabled {2}mode=all/)
})

test('config defaults the .env path to <repo>/.env', async () => {
  const repo = path.join(sandbox.dir, 'repo-with-env')
  mkdirSync(repo, { recursive: true })
  writeFileSync(path.join(repo, 'docker-compose.yml'), 'services: {}\n')
  writeFileSync(path.join(repo, '.env'), healthyEnvLines().join('\n') + '\n')
  const r = await runCli(sandbox, ['config', '--repo', repo])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Config looks good\./)
})

test('config --compose-config appends the resolved compose output', async () => {
  const envPath = writeEnvFile(sandbox, 'compose.env', healthyEnvLines())
  const r = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath, '--compose-config'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /\nResolved docker compose config:\n/)
  assert.match(r.stdout, /FAKE-DOCKER compose config/)
})

test('a failing `docker compose config` surfaces stderr and its exit code', async () => {
  const envPath = writeEnvFile(sandbox, 'compose-fail.env', healthyEnvLines())
  const r = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath, '--compose-config'], {
    env: { FAKE_DOCKER_EXIT: '5', FAKE_DOCKER_STDERR: 'compose blew up' },
  })
  assert.equal(r.code, 5)
  assert.match(r.stderr, /compose blew up/)
})

test('config --compose-config reports a missing docker as exit 127', async () => {
  const envPath = writeEnvFile(sandbox, 'compose-nodocker.env', healthyEnvLines())
  const r = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath, '--compose-config'], {
    withoutDocker: true,
  })
  assert.equal(r.code, 127)
})

test('a .env with comments, blanks and quoted values parses correctly', async () => {
  const envPath = writeEnvFile(sandbox, 'messy.env', [
    '# leading comment',
    '',
    '   ',
    'not-a-pair-line',
    ...healthyEnvLines().map((l) => (l.startsWith('MYSQL_PASSWORD=') ? 'MYSQL_PASSWORD="quoted value"' : l)),
  ])
  const r = await runCli(sandbox, ['config', '--repo', sandbox.repo, '--env', envPath])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /ok {7}MYSQL_PASSWORD \(set, 12 chars\)/)
})
