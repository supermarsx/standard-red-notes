import {
  AUTH_RUNTIME_PROBE_OUTCOMES,
  DATABASE_CONNECTION_STATES,
  MAX_REPORTED_CONSUMERS,
  MAX_REPORTED_MIGRATIONS,
  MAX_REPORTED_POOL,
  MAX_ROUND_TRIP_MS,
  MAX_UPTIME_SECONDS,
  QUEUE_SEPARATIONS,
  WRITE_PROBE_OUTCOMES,
  deriveQueueConsumerCount,
  deriveQueueSeparation,
  readAuthRuntimeBody,
} from './RuntimeDiagnostics'
import { DeploymentMode } from './DeploymentDiagnostics'

/**
 * Standard Red Notes: the runtime diagnostics reader and its three derivations.
 *
 * Two properties matter here.
 *
 * FIRST, the allowlist is the TRUST BOUNDARY, because this is the only part of
 * the admin payload that arrives from ANOTHER PROCESS over the wire. The auth
 * process is trusted today; the reader is written as if it were not, because a
 * build older than a field, a proxy answering on that port, and a newer auth
 * that grew a free-form field are all reachable without anyone being hostile.
 *
 * The sweeps below are therefore written the only way that holds: they assert on
 * WHAT IS EMITTED — every key against a declared contract, every value against
 * its declared type, closed set or bound — rather than scanning the output for a
 * list of forbidden substrings. A denylist cannot hold this: it passes any
 * secret with no structure, it passes a value shaped differently from the
 * sentinel, and it passes a field nobody thought to poison. The structural
 * assertion fails on all three, and it fails for a field this spec has never
 * heard of, which is the case that actually ships.
 *
 * SECOND, the queue verdict must OMIT rather than guess. `inherited-shared-queue`
 * is the one reading on this screen that names a defect which cost this
 * deployment roughly four in five realtime pushes, and a verdict invented from
 * presence alone would be exactly as confident while being wrong in the
 * operator's favour.
 */

/* -------------------------------------------------------------------------- */
/* The emitted contract, declared once                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every key the reader may emit, and what its value is allowed to be.
 *
 * `closed` means the value must be a member of that tuple. `bound` means it must
 * be a non-negative integer no larger than the bound. `boolean` means exactly a
 * boolean. A key emitted that is not listed here FAILS, so this object — not a
 * denylist — is what a new field has to be added to before it can ship.
 */
const EMITTED_CONTRACT: Record<
  string,
  { kind: 'boolean' } | { kind: 'closed'; allowed: readonly string[] } | { kind: 'bound'; max: number }
> = {
  authProcessUptimeSeconds: { kind: 'bound', max: MAX_UPTIME_SECONDS },
  cookieSecure: { kind: 'boolean' },
  cookiePartitioned: { kind: 'boolean' },
  e2eTesting: { kind: 'boolean' },
  connectionState: { kind: 'closed', allowed: [...DATABASE_CONNECTION_STATES, 'other'] },
  writeProbe: { kind: 'closed', allowed: [...WRITE_PROBE_OUTCOMES, 'other'] },
  migrationsApplied: { kind: 'boolean' },
  pendingMigrations: { kind: 'bound', max: MAX_REPORTED_MIGRATIONS },
  poolInUse: { kind: 'bound', max: MAX_REPORTED_POOL },
  poolSize: { kind: 'bound', max: MAX_REPORTED_POOL },
  readRoundTripMs: { kind: 'bound', max: MAX_ROUND_TRIP_MS },
  writeRoundTripMs: { kind: 'bound', max: MAX_ROUND_TRIP_MS },
}

/**
 * Assert the whole reading against the contract, key by key, recursing into the
 * one nested object (`datastore`).
 *
 * Returns the keys it checked so a test can additionally assert that it checked
 * something — an assertion sweep over an empty object passes trivially, and that
 * is the fourth way a secrecy test proves nothing.
 */
function assertEmittedContract(value: unknown, path = 'reading'): string[] {
  expect(typeof value).toBe('object')
  expect(value).not.toBeNull()

  const checked: string[] = []
  for (const [key, leaf] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'datastore') {
      checked.push(...assertEmittedContract(leaf, `${path}.datastore`))
      continue
    }

    const rule = EMITTED_CONTRACT[key]
    // A key the contract does not name is a failure, not a pass. This is the arm
    // that catches a field nobody thought to poison.
    if (rule === undefined) {
      throw new Error(`${path}.${key} is emitted but not named in EMITTED_CONTRACT`)
    }

    if (rule.kind === 'boolean') {
      expect(typeof leaf).toBe('boolean')
    } else if (rule.kind === 'closed') {
      expect(rule.allowed).toContain(leaf)
    } else {
      expect(typeof leaf).toBe('number')
      expect(Number.isInteger(leaf)).toBe(true)
      expect(leaf as number).toBeGreaterThanOrEqual(0)
      expect(leaf as number).toBeLessThanOrEqual(rule.max)
    }
    checked.push(`${path}.${key}`)
  }

  return checked
}

/* -------------------------------------------------------------------------- */
/* The hostile body                                                           */
/* -------------------------------------------------------------------------- */

/**
 * An auth answer in which EVERY leaf the reader looks at is a disclosure, in a
 * different shape each time, plus leaves the reader has never heard of.
 *
 * The shapes are deliberately varied, because a leak has more than one form: a
 * URL with a credential in it, a bare host and port, a 64-hex secret with no
 * structure at all, a free-form driver error (which is where a probe failure
 * puts an address), and a number far outside any bound. A sentinel-scan would
 * catch the first two and miss the third.
 */
const HOSTILE_BODY = {
  processUptimeSeconds: 'https://admin:hunter2@sqs.eu-west-1.amazonaws.com/123456789012/srn-events',
  session: {
    cookieSecure: 'true',
    cookiePartitioned: 'db.internal.example:3306',
    e2eTesting: 1,
    cookieDomain: 'notes.example.com',
  },
  datastore: {
    connectionState: 'mysql://std_notes_user:changeme123@db:3306/standard_notes_db',
    writeProbe: 'ER_OPTION_PREVENTS_STATEMENT: --read-only on db.internal.example:3306',
    migrationsApplied: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    pendingMigrations: Number.POSITIVE_INFINITY,
    poolInUse: -7,
    poolSize: 10 ** 12,
    readRoundTripMs: Number.NaN,
    writeRoundTripMs: 99_999_999,
    lastError: 'connect ECONNREFUSED 10.0.3.14:3306',
    schemaName: 'standard_notes_db',
    migrationNames: ['1700000000000-AddSharedVaultUsers'],
  },
  queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/srn-events',
  internalGrpcSecret: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
}

/* -------------------------------------------------------------------------- */

describe('readAuthRuntimeBody — the allowlist that holds the wire boundary', () => {
  it('emits nothing but contract-conformant keys from a body whose every leaf is a disclosure', () => {
    const reading = readAuthRuntimeBody(HOSTILE_BODY)

    expect(reading).toBeDefined()
    // Structural: every key emitted is named in the contract and every value
    // satisfies its declared type, closed set or bound.
    assertEmittedContract(reading)

    // And the two leaves that COULD still be admitted (they are the ones whose
    // declared type the hostile body happened to satisfy) are the only ones here.
    expect(Object.keys(reading as object)).toEqual(['datastore'])
    expect(reading?.datastore?.connectionState).toBe('other')
    expect(reading?.datastore?.writeProbe).toBe('other')
  })

  it('refuses to coerce a string boolean, so a flag can never be fabricated from text', () => {
    // `'true'` is the shape an env-derived flag arrives in, and coercing it is
    // how a cookie row comes to assert an attribute the server never set. Both
    // cookie attributes default to ON when their variable is unset, so a
    // fabricated reading here inverts the diagnosis rather than blurring it.
    const reading = readAuthRuntimeBody({ session: { cookieSecure: 'true', cookiePartitioned: 'false' } })

    expect(reading).toEqual({})
  })

  it('drops a malformed figure rather than rounding it down to a reassuring zero', () => {
    const reading = readAuthRuntimeBody({
      datastore: {
        connectionState: 'connected',
        writeProbe: 'accepted',
        pendingMigrations: Number.NaN,
        readRoundTripMs: -1,
      },
    })

    // Zero pending migrations is a HEALTHY SCHEMA and zero milliseconds is a
    // plausible round trip, so neither may stand in for "unreadable".
    expect(reading?.datastore).toEqual({ connectionState: 'connected', writeProbe: 'accepted' })
  })

  it('refuses a figure above the bound instead of clamping it into a plausible one', () => {
    // Clamping `1e9` to the ceiling would put a number on an operator's screen
    // that no process ever measured. The bound is this build's statement about
    // what a conforming producer can report, so a figure outside it is malformed
    // by that contract and is dropped exactly like a NaN.
    const reading = readAuthRuntimeBody({
      datastore: { connectionState: 'connected', writeProbe: 'accepted', readRoundTripMs: 10 ** 9 },
    })

    expect(reading?.datastore?.readRoundTripMs).toBeUndefined()

    // A figure AT the bound is still a real measurement and is admitted.
    const atBound = readAuthRuntimeBody({
      datastore: { connectionState: 'connected', writeProbe: 'accepted', readRoundTripMs: MAX_ROUND_TRIP_MS },
    })
    expect(atBound?.datastore?.readRoundTripMs).toBe(MAX_ROUND_TRIP_MS)
  })

  it('admits a well-formed body in full, so the sweep above is not passing on an empty object', () => {
    const reading = readAuthRuntimeBody({
      processUptimeSeconds: 931.77,
      session: { cookieSecure: false, cookiePartitioned: false, e2eTesting: false },
      datastore: {
        connectionState: 'connected',
        writeProbe: 'accepted',
        migrationsApplied: true,
        pendingMigrations: 0,
        poolInUse: 2,
        poolSize: 20,
        readRoundTripMs: 3,
        writeRoundTripMs: 4,
      },
    })

    const checked = assertEmittedContract(reading)
    // Twelve leaves actually inspected. Without this the contract sweep would
    // pass over a reader that emitted nothing at all.
    expect(checked).toHaveLength(12)
    expect(reading?.authProcessUptimeSeconds).toBe(931)
    expect(reading?.cookieSecure).toBe(false)
    expect(reading?.datastore?.poolInUse).toBe(2)
  })

  it('reports an unreadable body as unreadable rather than as an empty reading', () => {
    // The distinction the caller turns into `authRuntimeProbe`: an auth older
    // than the route answers something that is not a record, and that is a
    // different fact from an auth that answered with nothing to say.
    expect(readAuthRuntimeBody(undefined)).toBeUndefined()
    expect(readAuthRuntimeBody('ECONNREFUSED 10.0.3.14:3306')).toBeUndefined()
    expect(readAuthRuntimeBody([{ connectionState: 'connected' }])).toBeUndefined()
    expect(readAuthRuntimeBody({})).toEqual({})
  })
})

describe('deriveQueueConsumerCount', () => {
  const count = (queueConfigured: boolean, available: boolean, statuses: Record<string, string>): number | undefined =>
    deriveQueueConsumerCount({ queueConfigured, supervisord: { available, statuses } })

  it('says nothing — not zero, and not one — when the control channel said nothing', () => {
    // An image whose supervisord conf lacks the [supervisorctl] socket sections
    // cannot be asked. `1` would read as "I am the only consumer" and is exactly
    // the reading that would turn a live collision into a clean screen.
    expect(count(true, false, {})).toBeUndefined()
  })

  it('counts this gateway plus every co-resident worker', () => {
    expect(
      count(true, true, {
        'api-gateway': 'RUNNING',
        'auth-worker': 'RUNNING',
        'syncing-server-worker': 'RUNNING',
        'files-worker': 'RUNNING',
        'revisions-worker': 'RUNNING',
      }),
    ).toBe(5)
  })

  it('counts a STOPPED or FATAL worker, because it drains that queue the moment it returns', () => {
    // Excluding it would make the collision vanish from the screen for exactly
    // as long as the worker was down, which is when an operator is reading.
    expect(count(true, true, { 'auth-worker': 'STOPPED' })).toBe(2)
    expect(count(true, true, { 'files-worker': 'FATAL' })).toBe(2)
  })

  it('does not count this gateway when no queue is configured for it', () => {
    expect(count(false, true, { 'auth-worker': 'RUNNING' })).toBe(1)
    expect(count(false, true, { 'api-gateway': 'RUNNING' })).toBe(0)
  })

  it('bounds the census', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < MAX_REPORTED_CONSUMERS + 10; i++) {
      many[`svc${i}-worker`] = 'RUNNING'
    }

    expect(count(true, true, many)).toBe(MAX_REPORTED_CONSUMERS)
  })
})

describe('deriveQueueSeparation — the verdict presence cannot express', () => {
  const derive = (input: {
    own?: boolean
    bare?: boolean
    mode?: DeploymentMode
    consumers?: number | undefined
  }): string | undefined =>
    deriveQueueSeparation({
      ownPrefixedQueuePresent: input.own ?? false,
      bareQueuePresent: input.bare ?? false,
      mode: input.mode ?? 'self-hosted',
      consumerCount: input.consumers,
    })

  it('names the collision when a bare queue meets co-resident workers', () => {
    // The measured defect: both halves drain one queue, each message is
    // delivered once, and roughly four in five realtime pushes plus revision and
    // e-mail events went to whichever consumer won the race.
    expect(derive({ bare: true, consumers: 5 })).toBe('inherited-shared-queue')
  })

  it('reports the fix as in place when the gateway owns a prefixed queue', () => {
    expect(derive({ own: true, bare: true, consumers: 5 })).toBe('own-prefixed-queue')
  })

  it('OMITS the verdict when the other consumers are not visible from this process', () => {
    // THE CASE THE WHOLE FIELD TURNS ON. A standalone gateway with one bare
    // queue and a compose stack whose workers inherited that same bare queue
    // produce IDENTICAL booleans; with no co-resident consumer to compare
    // against, a second consumer could still be in another container. A row
    // reading "not reported" is better than a row that says the fix is in place.
    expect(derive({ bare: true, consumers: undefined })).toBeUndefined()
    expect(derive({ bare: true, consumers: 1 })).toBeUndefined()
    expect(derive({ bare: true, consumers: 0 })).toBeUndefined()
  })

  it('separates no-queue-at-all into the two topologies that mean opposite things', () => {
    // On the bundled single process the fan-out is a function call into the same
    // registry, which is correct; on the compose stack the absence is the fault.
    expect(derive({ mode: 'home-server' })).toBe('in-process-fan-out')
    expect(derive({ mode: 'self-hosted' })).toBe('none')
  })

  it('makes no claim on a topology it cannot name', () => {
    expect(derive({ mode: 'unset' })).toBeUndefined()
    expect(derive({ mode: 'other' })).toBeUndefined()
  })

  it('only ever answers with a member of the panel’s own tuple', () => {
    const modes: DeploymentMode[] = ['home-server', 'self-hosted', 'unset', 'other']
    const answers = new Set<string | undefined>()
    for (const own of [true, false]) {
      for (const bare of [true, false]) {
        for (const consumers of [0, 1, 5, undefined]) {
          for (const mode of modes) {
            answers.add(derive({ own, bare, consumers, mode }))
          }
        }
      }
    }

    for (const answer of answers) {
      if (answer !== undefined) {
        expect(QUEUE_SEPARATIONS).toContain(answer)
      }
    }
    // The exhaustive sweep must actually reach every member, or this test would
    // pass over a function that only ever returned one of them.
    expect([...QUEUE_SEPARATIONS].every((member) => answers.has(member))).toBe(true)
  })
})

describe('the probe outcome vocabulary', () => {
  it('keeps four members, because the four situations have four different fixes', () => {
    // `not-configured` has no address to dial, `unreachable` dialled and failed
    // (the bundled home server, where auth runs in-process with no listener),
    // `unreadable` answered with a body this build could not admit. Collapsing
    // any two sends an operator to the wrong container.
    expect([...AUTH_RUNTIME_PROBE_OUTCOMES]).toEqual(['answered', 'unreachable', 'not-configured', 'unreadable'])
  })
})
