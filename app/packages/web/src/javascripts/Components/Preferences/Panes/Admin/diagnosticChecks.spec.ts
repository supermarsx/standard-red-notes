import {
  AUTO_CHECK_IDS,
  buildChecksBlock,
  buildWitnessBoard,
  CHECK_IDS,
  CHECK_MODES,
  CHECK_STATE_VERDICT,
  CHECK_STATES,
  checkRow,
  CHECKS,
  describeMarkerCheck,
  howToRun,
  LIVE_CHECK_IDS,
  PASSIVE_WITNESS_IDS,
  readingsFrom,
  RUNNABLE_CHECK_IDS,
  summarizeChecks,
  UNOBSERVED_BOARD,
  WITNESS_IDS,
  witnessFrom,
  type CheckId,
  type CheckOutcome,
  type CheckState,
  type WitnessTransport,
} from './diagnosticChecks'
import {
  readingOf,
  safeConstant,
  safeNotAvailableHere,
  SECTION_IDS,
  WITNESS_STATES,
  type Verdict,
  type WitnessState,
} from './diagnosticsSections'

const outcome = (id: CheckOutcome['id'], state: CheckState, detail = 'what the operator sees'): CheckOutcome => ({
  id,
  state,
  result:
    state === 'not-applicable' ? safeNotAvailableHere('another tab holds the socket lane') : safeConstant('result'),
  detail,
})

/** Every registered check, run and passed. */
const allPassed = (): Partial<Record<CheckId, CheckOutcome>> =>
  Object.fromEntries(CHECK_IDS.map((id) => [id, outcome(id, 'pass')])) as Partial<Record<CheckId, CheckOutcome>>

describe('the check registry', () => {
  it('defines every check under its own id, in a section the contract has, in a mode it has', () => {
    expect(Object.keys(CHECKS).sort()).toEqual([...CHECK_IDS].sort())
    expect(new Set(CHECK_IDS).size).toBe(CHECK_IDS.length)

    for (const id of CHECK_IDS) {
      const definition = CHECKS[id]

      expect(definition.id).toBe(id)
      expect(SECTION_IDS).toContain(definition.section)
      expect(CHECK_MODES).toContain(definition.mode)
      // Each says what it does and what a pass establishes, in real sentences.
      expect(definition.does.length).toBeGreaterThan(40)
      expect(definition.establishes.length).toBeGreaterThan(15)
      expect(String(definition.title).length).toBeGreaterThan(5)
    }
    // Titles are row labels and report names, so two alike would be one row.
    expect(new Set(CHECK_IDS.map((id) => String(CHECKS[id].title))).size).toBe(CHECK_IDS.length)
  })

  /**
   * The two tuples and the `mode` field say the same thing three ways, and a
   * check for which they disagreed would either have a runner nobody calls or be
   * a row nothing can ever fill in.
   */
  it('agrees with itself about which checks send something', () => {
    for (const id of CHECK_IDS) {
      const live = (LIVE_CHECK_IDS as readonly string[]).includes(id)

      expect({ id, live }).toEqual({ id, live: CHECKS[id].mode === 'live' })
      expect({ id, runnable: (RUNNABLE_CHECK_IDS as readonly string[]).includes(id) }).toEqual({ id, runnable: !live })
    }
    expect([...LIVE_CHECK_IDS, ...RUNNABLE_CHECK_IDS].sort()).toEqual([...CHECK_IDS].sort())
    // What runs on open is read-only by construction.
    for (const id of AUTO_CHECK_IDS) {
      expect(CHECKS[id].mode).toBe('auto')
    }
    expect(AUTO_CHECK_IDS.length).toBeGreaterThan(0)
  })

  /**
   * *** A CHECK THAT WRITES SAYS SO, IN ITS OWN WORDS. *** `does` is the consent:
   * it is the sentence shown beside the button that starts the run. For an
   * `operator` check it must name the write.
   */
  it('makes every check that writes say what it writes, and every other one say it writes nothing', () => {
    const operator = CHECK_IDS.filter((id) => CHECKS[id].mode === 'operator')

    expect(operator).toEqual(['ticket'])
    expect(CHECKS.ticket.does).toContain('mint ONE short-lived, single-use socket ticket')
    expect(CHECKS.ticket.does).toContain('never redeemed')
    expect(CHECKS.ticket.does).toContain('Nothing else is written')
    for (const id of CHECK_IDS.filter((candidate) => CHECKS[candidate].mode !== 'operator')) {
      expect({ id, says: /Read-only|Sends nothing/.test(CHECKS[id].does) }).toEqual({ id, says: true })
    }
  })
})

describe('a check as a row', () => {
  it('reads not tested — never unknown, never a pass — until it has run, and says how to run it', () => {
    for (const id of CHECK_IDS) {
      const row = checkRow({ definition: CHECKS[id] })

      expect({ id, verdict: row.verdict }).toEqual({ id, verdict: 'untested' })
      expect(readingOf(row.value)).toBe('untested')
      expect(row.evidence.kind).toBe('untested')
      expect(row.caveat).toBe(`Not tested yet: ${howToRun(CHECKS[id])}.`)
      expect(row.label).toBe(CHECKS[id].title)
      // What it does is on the row before it has been run.
      expect(row.note).toBe(CHECKS[id].does)
    }
  })

  it('gives each outcome the verdict it earned, on direct evidence', () => {
    const expected: Record<CheckState, Verdict> = {
      pass: 'healthy',
      degraded: 'degraded',
      fail: 'broken',
      unknown: 'undetermined',
      'not-applicable': 'not-applicable',
    }
    expect(Object.keys(expected).sort()).toEqual([...CHECK_STATES].sort())
    expect(CHECK_STATE_VERDICT).toEqual(expected)

    for (const state of CHECK_STATES) {
      const row = checkRow({ definition: CHECKS.ticket, outcome: outcome('ticket', state) })

      expect({ state, verdict: row.verdict }).toEqual({ state, verdict: expected[state] })
      expect(row.evidence.kind).toBe(state === 'not-applicable' ? 'unavailable' : 'direct')
    }
  })

  it('prints a ran check’s closed result as its value and its detail as prose', () => {
    const row = checkRow({ definition: CHECKS.ticket, outcome: outcome('ticket', 'fail', 'Refused with 503.') })

    expect(String(row.value)).toBe('result')
    expect(row.note).toContain('Refused with 503.')
    expect(row.note).toContain(CHECKS.ticket.does)
  })

  /**
   * A check with nothing to test here carries its reason as a NOT-AVAILABLE value,
   * so the reading derived from the value and the verdict agree. A check that
   * forgot to — handing an ordinary value with a not-applicable state — still
   * gets a value whose reading is right, rather than a row that says both.
   */
  it('keeps the value and the verdict in step for a check with nothing to test here', () => {
    const proper = checkRow({ definition: CHECKS.negotiation, outcome: outcome('negotiation', 'not-applicable') })
    const sloppy = checkRow({
      definition: CHECKS.negotiation,
      outcome: { ...outcome('negotiation', 'not-applicable'), result: safeConstant('READY') },
    })

    expect(String(proper.value)).toBe('not available here (another tab holds the socket lane)')
    expect(String(sloppy.value)).toBe('not available here (nothing to test here)')
    for (const row of [proper, sloppy]) {
      expect(readingOf(row.value)).toBe('unavailable')
      expect(row.verdict).toBe('not-applicable')
      expect(row.caveat).toBe('what the operator sees')
    }
  })

  it('builds a block only for a section that has a check, and only when readings were supplied', () => {
    const readings = readingsFrom({})

    expect(buildChecksBlock('websocket', undefined)).toBeUndefined()
    expect(buildChecksBlock('websocket', [])).toBeUndefined()
    for (const section of SECTION_IDS) {
      const mine = CHECK_IDS.filter((id) => CHECKS[id].section === section)
      const block = buildChecksBlock(section, readings)

      expect({ section, built: block !== undefined }).toEqual({ section, built: mine.length > 0 })
      expect((block?.rows ?? []).map((row) => String(row.label))).toEqual(mine.map((id) => String(CHECKS[id].title)))
    }
  })
})

describe('readingsFrom and summarizeChecks', () => {
  it('lists every registered check in registry order, with an outcome only where one exists', () => {
    const readings = readingsFrom({ ticket: outcome('ticket', 'pass') }, ['capabilities'])

    expect(readings.map((reading) => reading.definition.id)).toEqual([...CHECK_IDS])
    expect(readings.filter((reading) => reading.outcome !== undefined).map((reading) => reading.definition.id)).toEqual(
      ['ticket'],
    )
    expect(readings.filter((reading) => reading.running === true).map((reading) => reading.definition.id)).toEqual([
      'capabilities',
    ])
  })

  /**
   * *** THE DENOMINATOR IS THE REGISTRY. *** "5 of 5 checks passed" over a registry
   * of nine is the flattering denominator, and it is the sentence at the top of
   * the pane. Every case is spelled out, including the one where nothing has run.
   */
  it('counts over every registered check, and says how many never ran', () => {
    const total = CHECK_IDS.length

    expect(summarizeChecks(readingsFrom({}))).toBe(`0 of ${total} checks passed, ${total} not run yet.`)
    expect(summarizeChecks(readingsFrom({ ticket: outcome('ticket', 'pass') }))).toBe(
      `1 of ${total} checks passed, ${total - 1} not run yet.`,
    )
    expect(summarizeChecks(readingsFrom(allPassed()))).toBe(`${total} of ${total} checks passed.`)
    expect(
      summarizeChecks(
        readingsFrom({
          ...allPassed(),
          ticket: outcome('ticket', 'fail'),
          negotiation: outcome('negotiation', 'not-applicable'),
        }),
      ),
    ).toBe(`${total - 2} of ${total - 1} checks passed, 1 did not pass, 1 had nothing to test here.`)
  })

  it('never counts a degraded or unknown result as a pass', () => {
    for (const state of ['degraded', 'unknown', 'fail'] as const) {
      const summary = summarizeChecks(
        readingsFrom({
          ...allPassed(),
          ticket: outcome('ticket', state),
        }),
      )

      expect({ state, summary }).toEqual({
        state,
        summary: `${CHECK_IDS.length - 1} of ${CHECK_IDS.length} checks passed, 1 did not pass.`,
      })
    }
  })
})

describe('describeMarkerCheck', () => {
  const real = 'ab3f90'.repeat(6) + 'cdef'

  it('passes on a stamped marker and prints the revision it admitted by shape', () => {
    const result = describeMarkerCheck({ revision: real, version: 'rel-1.2.3' }, 'answered')

    expect(result.state).toBe('pass')
    expect(String(result.result)).toBe(`revision ${real}`)
  })

  it('does not call a marker that could not be fetched "unstamped"', () => {
    const failed = describeMarkerCheck({}, 'failed')
    const blank = describeMarkerCheck({}, 'answered')

    expect(failed.state).toBe('fail')
    expect(String(failed.result)).toBe('the marker could not be read')
    // A marker that ARRIVED and names no build is a different fact: nothing is
    // broken, and which commit is live cannot be said.
    expect(blank.state).toBe('unknown')
    expect(describeMarkerCheck({ revision: 'unstamped', version: 'unstamped' }, 'answered').state).toBe('unknown')
  })

  /**
   * The result is the check's whole contribution to the copyable report. Whatever
   * the marker carries, it is this build's own words or a 40-hex revision.
   */
  it('never puts a marker value it did not recognise into its result', () => {
    const planted = [
      ['zq', 'marker', 'sentinel', 'k9x2'].join('~ '),
      ['build', 'internal.example.test'].join('@'),
      real.toUpperCase(),
      `${real}0`,
      real.slice(1),
    ]

    for (const revision of planted) {
      const result = describeMarkerCheck({ revision, version: revision }, 'answered')

      expect({ revision, state: result.state }).toEqual({ revision, state: 'unknown' })
      expect(String(result.result)).toBe('no usable build identity in the marker')
    }
  })
})

describe('the witness board', () => {
  const READY: WitnessTransport = {
    state: 'READY',
    operations: ['SYNC_ITEMS', 'FILES_V1', 'API_RPC'],
    deferred: false,
  }

  it('covers every witness, checks and passive observations alike, and nothing else', () => {
    const board = buildWitnessBoard({ checks: readingsFrom({}) })

    expect(Object.keys(board).sort()).toEqual([...WITNESS_IDS].sort())
    expect(WITNESS_IDS.slice().sort()).toEqual([...CHECK_IDS, ...PASSIVE_WITNESS_IDS].sort())
    for (const id of WITNESS_IDS) {
      expect(WITNESS_STATES).toContain(board[id].state)
      expect(board[id].what.length).toBeGreaterThan(15)
    }
  })

  /**
   * *** A BUILDER HANDED NO BOARD CAN NEVER COME TO READ OK. *** Every witness on
   * the unobserved board is `unknown`, which is the one state that leaves a capped
   * row exactly where the cap put it.
   */
  it('observes nothing when no board is supplied', () => {
    const witness = witnessFrom(undefined)

    for (const id of WITNESS_IDS) {
      expect({ id, state: witness(id).state }).toEqual({ id, state: 'unknown' })
      expect(witness(id)).toBe(UNOBSERVED_BOARD[id])
    }
  })

  it('makes a check a witness of its own outcome, and says how to run one that has not', () => {
    const expected: Record<CheckState, WitnessState> = {
      pass: 'confirmed',
      // Half working does not confirm that the thing a row is necessary for works.
      degraded: 'refuted',
      fail: 'refuted',
      unknown: 'unknown',
      'not-applicable': 'unavailable',
    }

    for (const state of CHECK_STATES) {
      const board = buildWitnessBoard({ checks: readingsFrom({ ticket: outcome('ticket', state, 'why not') }) })

      expect({ state, witness: board.ticket.state }).toEqual({ state, witness: expected[state] })
      expect(board.ticket.what).toBe(CHECKS.ticket.establishes)
    }
    expect(
      buildWitnessBoard({ checks: readingsFrom({ ticket: outcome('ticket', 'not-applicable', 'why not') }) }).ticket
        .how,
    ).toBe('why not')

    const notRun = buildWitnessBoard({ checks: readingsFrom({}) }).ticket
    expect(notRun.state).toBe('not-run')
    expect(notRun.how).toBe(howToRun(CHECKS.ticket))
  })

  it('confirms an operation only on a socket that is up and carries it', () => {
    const board = (transport: WitnessTransport | undefined, serverOperations?: readonly string[]) =>
      buildWitnessBoard({
        checks: readingsFrom({}),
        ...(transport === undefined ? {} : { transport }),
        ...(serverOperations === undefined ? {} : { serverOperations }),
      })

    expect(board(READY)['sync-items'].state).toBe('confirmed')
    expect(board(READY)['files-lane'].state).toBe('confirmed')
    // UP and NOT carrying it is conclusive: the operation was withheld.
    expect(board({ ...READY, operations: ['API_RPC'] })['sync-items'].state).toBe('refuted')
    // A socket that is not there to ask is not a no.
    expect(board(undefined)['sync-items'].state).toBe('unknown')
    expect(board({ ...READY, state: 'HTTP_FALLBACK', operations: [] })['sync-items'].state).toBe('unknown')
    expect(board({ ...READY, state: 'CONNECTING', operations: [] })['sync-items'].state).toBe('unknown')
    // A tab standing down for a sibling cannot observe either way, and says why.
    const deferred = board({ state: 'HTTP_FALLBACK', operations: [], deferred: true })['sync-items']
    expect(deferred.state).toBe('unavailable')
    expect(deferred.how).toContain('another tab of this account holds the socket lane')
  })

  /**
   * "Every operation the server advertises" needs the server's list. Without it
   * the question cannot be asked, and with one operation missing the answer is no
   * — which is the withheld-operation case an empty condition list used to hide.
   */
  it('confirms that every advertised operation was negotiated only against the server’s own list', () => {
    const witness = (serverOperations?: readonly string[]) =>
      buildWitnessBoard({
        checks: readingsFrom({}),
        transport: READY,
        ...(serverOperations === undefined ? {} : { serverOperations }),
      })['all-operations'].state

    expect(witness(undefined)).toBe('unknown')
    expect(witness(['SYNC_ITEMS', 'FILES_V1', 'API_RPC'])).toBe('confirmed')
    expect(witness(['SYNC_ITEMS', 'FILES_V1', 'API_RPC', 'INVITE_EVENTS'])).toBe('refuted')
  })

  it('reads each passive observation as three-valued: made and held, made and failed, or not made', () => {
    const read = (input: Parameters<typeof buildWitnessBoard>[0]) => buildWitnessBoard(input)
    const none = read({ checks: readingsFrom({}) })

    for (const id of ['admin-read', 'crypto', 'gateway-cache'] as const) {
      expect({ id, state: none[id].state }).toEqual({ id, state: 'unknown' })
    }
    expect(read({ checks: [], adminRead: true })['admin-read'].state).toBe('confirmed')
    expect(read({ checks: [], adminRead: false })['admin-read'].state).toBe('refuted')
    expect(read({ checks: [], cryptoWorks: true }).crypto.state).toBe('confirmed')
    expect(read({ checks: [], cryptoWorks: false }).crypto.state).toBe('refuted')
    expect(read({ checks: [], gatewayCachePing: true })['gateway-cache'].state).toBe('confirmed')
    expect(read({ checks: [], gatewayCachePing: false })['gateway-cache'].state).toBe('refuted')
    // A database that has not finished loading is still loading — not unopenable.
    expect(read({ checks: [], localDatabaseLoaded: true })['local-database'].state).toBe('confirmed')
    expect(read({ checks: [], localDatabaseLoaded: false })['local-database'].state).toBe('unknown')
  })
})
