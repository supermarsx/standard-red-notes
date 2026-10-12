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
  describeAppShellCheck,
  describeControlPlaneRead,
  describeFileTransfer,
  describeMarkerCheck,
  describeRevisionsRead,
  describeServerBuildCheck,
  describeSyncRound,
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
  FILE_SOCKET_READS,
  FILE_TRANSFER_CLEANUPS,
  FILE_TRANSFER_STAGES,
  FILE_TRANSFER_USAGES,
  type FileTransferResult,
} from './diagnosticFileTransfer'
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

    expect(operator).toEqual(['ticket', 'file-transfer'])
    expect(CHECKS.ticket.does).toContain('mint ONE short-lived, single-use socket ticket')
    expect(CHECKS.ticket.does).toContain('never redeemed')
    expect(CHECKS.ticket.does).toContain('Nothing else is written')
    // The one check that stores something says how much, that it is not a file of
    // the operator's, that theirs are untouched, and what happens when it fails.
    const transfer = CHECKS['file-transfer'].does
    expect(transfer).toContain('Uploads ONE throwaway object of 16 KiB of random bytes')
    expect(transfer).toContain('then deletes it')
    expect(transfer).toContain('No file item is created')
    expect(transfer).toContain('none of your own files is read, changed or removed')
    expect(transfer).toContain('deleted even when an earlier step fails')
    expect(transfer).toContain('if the delete itself fails, the result says so')
    // *** WHY THE UPLOAD IS HTTP AND ONLY THE READ-BACK IS THE SOCKET. *** The
    // consent says which lane writes; a check that uploaded over the socket would
    // be accounted differently and could leave the usage figure wrong.
    expect(transfer).toContain('over HTTP, under an identifier made up for this check')

    for (const id of CHECK_IDS.filter((candidate) => CHECKS[candidate].mode !== 'operator')) {
      expect({ id, says: /Read-only|Sends nothing|makes no change of its own/.test(CHECKS[id].does) }).toEqual({
        id,
        says: true,
      })
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

/* -------------------------------------------------------------------------- */
/* The checks that test a whole path                                          */
/* -------------------------------------------------------------------------- */

describe('describeSyncRound', () => {
  const none = { socket: 4, http: 1, failed: 0 }

  it('reads the round off the difference between two counter readings, never off the call returning', () => {
    const overSocket = describeSyncRound({ before: none, after: { ...none, socket: 5 }, socketCarriesSync: true })
    const nothing = describeSyncRound({ before: none, after: none, socketCarriesSync: true })

    expect(overSocket.state).toBe('pass')
    expect(String(overSocket.result)).toBe('completed over the socket')
    // The call returned in both cases. Only one of them is a sync.
    expect(nothing.state).toBe('unknown')
    expect(String(nothing.result)).toBe('no sync round settled')
  })

  /**
   * *** HTTP IS A WORKING SYNC, AND "WITH SOMETHING LOST" ONLY WHERE THE SOCKET
   * HAD AGREED TO CARRY IT. *** The control is the same round on a tab whose
   * socket does not carry sync: that is the lane working as deployed.
   */
  it('calls an HTTP round degraded only on a tab whose socket negotiated sync', () => {
    const after = { ...none, http: 2 }
    const agreed = describeSyncRound({ before: none, after, socketCarriesSync: true })
    const notOffered = describeSyncRound({ before: none, after, socketCarriesSync: false })

    expect(agreed.state).toBe('degraded')
    expect(String(agreed.result)).toBe('completed over HTTP, although this socket negotiated SYNC_ITEMS')
    expect(notOffered.state).toBe('pass')
    expect(String(notOffered.result)).toBe('completed over HTTP')
  })

  it('fails only when a round was tried and completed on no lane', () => {
    const failed = describeSyncRound({ before: none, after: { ...none, failed: 1 }, socketCarriesSync: true })
    // A failure followed by a success in the same window is a sync that worked.
    const recovered = describeSyncRound({
      before: none,
      after: { socket: 5, http: 1, failed: 1 },
      socketCarriesSync: true,
    })

    expect(failed.state).toBe('fail')
    expect(recovered.state).toBe('pass')
  })

  it('says it could not observe the round on a build with no transport to count with', () => {
    expect(describeSyncRound({ before: undefined, after: undefined, socketCarriesSync: false }).state).toBe('unknown')
  })
})

describe('describeControlPlaneRead', () => {
  /**
   * *** THE LANE IS MEASURED. *** This check said "API_RPC is negotiated, so the
   * socket lane carries it" — an inference that is wrong for exactly the socket
   * it exists to catch: the stranded one, which refuses the read while HTTP
   * quietly serves it.
   */
  it('reports the lane that carried the read, and calls HTTP on a negotiated lane what it is', () => {
    const socket = describeControlPlaneRead({ status: 200, ok: true, carriedBy: 'socket', apiRpcNegotiated: true })
    const stranded = describeControlPlaneRead({ status: 200, ok: true, carriedBy: 'http', apiRpcNegotiated: true })
    const httpOnly = describeControlPlaneRead({ status: 200, ok: true, carriedBy: 'http', apiRpcNegotiated: false })

    expect(socket.state).toBe('pass')
    expect(String(socket.result)).toBe('answered over the socket’s control-plane lane')
    expect(stranded.state).toBe('degraded')
    expect(String(stranded.result)).toBe('answered over HTTP, although this socket negotiated API_RPC')
    expect(httpOnly.state).toBe('pass')
    expect(String(httpOnly.result)).toBe('answered over HTTP')
  })

  /**
   * The round trip through the socket and whatever sits in front of it. A figure
   * and never a verdict: there is no latency a deployment owes this pane.
   */
  it('prints how long a read over the socket took, as whole milliseconds, without judging it', () => {
    const read = (elapsedMs: number | undefined) =>
      describeControlPlaneRead({
        status: 200,
        ok: true,
        carriedBy: 'socket',
        apiRpcNegotiated: true,
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
      })

    expect(String(read(41.6).result)).toBe('answered over the socket’s control-plane lane · 42 ms')
    expect(String(read(0).result)).toBe('answered over the socket’s control-plane lane · 0 ms')
    expect(read(9_000).state).toBe('pass')
    // Untimed, or timed nonsensically, it claims no figure at all.
    for (const elapsedMs of [undefined, Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      expect(String(read(elapsedMs).result)).toBe('answered over the socket’s control-plane lane')
    }
  })

  it('reads a refusal as unknown and only a server failure as not working, whatever the lane', () => {
    for (const carriedBy of ['socket', 'http'] as const) {
      for (const status of [401, 403, 404]) {
        const refused = describeControlPlaneRead({ status, ok: false, carriedBy, apiRpcNegotiated: true })
        expect({ status, state: refused.state }).toEqual({ status, state: 'unknown' })
      }
      expect(describeControlPlaneRead({ status: 502, ok: false, carriedBy, apiRpcNegotiated: true }).state).toBe('fail')
    }
  })
})

describe('describeRevisionsRead', () => {
  it('passes on an answer, has nothing to test without a note, and separates a refusal from a failure', () => {
    expect(describeRevisionsRead({ status: 200 }).state).toBe('pass')
    expect(describeRevisionsRead('no-note').state).toBe('not-applicable')
    expect(readingOf(describeRevisionsRead('no-note').result)).toBe('unavailable')
    expect(describeRevisionsRead({ status: 403 }).state).toBe('unknown')
    expect(describeRevisionsRead({ status: 502 }).state).toBe('fail')
    expect(String(describeRevisionsRead({ status: 502 }).result)).toBe('answered HTTP 502')
  })
})

describe('describeFileTransfer', () => {
  const worked: FileTransferResult = { socketRead: 'matched', cleanup: 'deleted', usage: 'returned' }

  it('passes when the object was stored, read back on both lanes and deleted', () => {
    const outcome = describeFileTransfer(worked)

    expect(outcome.state).toBe('pass')
    expect(String(outcome.result)).toBe('stored, read back intact over HTTP and over the socket · deleted')
  })

  it('passes over HTTP alone where the socket did not negotiate files, and says the lane was not exercised', () => {
    const outcome = describeFileTransfer({ ...worked, socketRead: 'not-negotiated' })

    expect(outcome.state).toBe('pass')
    expect(String(outcome.result)).toBe('stored, read back intact over HTTP · deleted')
    expect(outcome.detail).toContain('the socket file lane was not exercised')
  })

  it('names the step that failed and what became of the object, for every stage', () => {
    const seen = new Set<string>()
    for (const failedAt of FILE_TRANSFER_STAGES) {
      const outcome = describeFileTransfer({
        failedAt,
        socketRead: 'not-reached',
        cleanup: 'deleted',
        usage: 'returned',
      })

      expect({ failedAt, state: outcome.state }).toEqual({ failedAt, state: 'fail' })
      expect(String(outcome.result)).toMatch(/ · deleted$/)
      seen.add(String(outcome.result))
    }
    // Seven stages, seven different sentences: none inherits another's.
    expect(seen.size).toBe(FILE_TRANSFER_STAGES.length)
    expect(
      String(
        describeFileTransfer({
          failedAt: 'authorize-upload',
          socketRead: 'not-reached',
          cleanup: 'nothing-stored',
          usage: 'returned',
        }).result,
      ),
    ).toBe('the server would not authorize an upload · nothing was stored')
  })

  /**
   * *** "WORKING, WITH SOMETHING LOST" — THREE WAYS, AND NONE IS A FAILURE. ***
   * The transfer worked in all of them; what differs is what was lost, and the
   * row says which.
   */
  it('is degraded, not failed, when the transfer worked and something was lost', () => {
    const socket = describeFileTransfer({ ...worked, socketRead: 'failed' })
    const corrupt = describeFileTransfer({ ...worked, socketRead: 'mismatched' })
    const leftover = describeFileTransfer({ ...worked, cleanup: 'failed', usage: 'not-reported' })
    const counter = describeFileTransfer({ ...worked, usage: 'not-returned' })

    for (const outcome of [socket, corrupt, leftover, counter]) {
      expect(outcome.state).toBe('degraded')
      expect(String(outcome.result)).toContain('stored, read back intact over HTTP')
    }
    expect(String(socket.result)).toContain('the socket lane did not return it')
    expect(corrupt.detail).toContain('returned different bytes')
    expect(String(leftover.result)).toContain('THE THROWAWAY OBJECT COULD NOT BE DELETED')
    expect(leftover.detail).toContain('16 KiB of random bytes remain')
    expect(String(counter.result)).toContain('the usage counter did not come back')
  })

  it('says a leftover out loud even when the transfer itself failed', () => {
    const outcome = describeFileTransfer({
      failedAt: 'read',
      socketRead: 'not-reached',
      cleanup: 'failed',
      usage: 'not-reported',
    })

    expect(outcome.state).toBe('fail')
    expect(String(outcome.result)).toBe(
      'the stored object could not be read back · THE THROWAWAY OBJECT COULD NOT BE DELETED',
    )
  })

  /**
   * The counter not being READABLE is not the counter being wrong, and a counter
   * that did not move during the transfer is not read at all.
   */
  it('does not hold an unreadable usage counter against a transfer that worked', () => {
    expect(describeFileTransfer({ ...worked, usage: 'not-reported' }).state).toBe('pass')
  })

  it('has a verdict for every combination the runner can return, and never throws', () => {
    for (const socketRead of FILE_SOCKET_READS) {
      for (const cleanup of FILE_TRANSFER_CLEANUPS) {
        for (const usage of FILE_TRANSFER_USAGES) {
          for (const failedAt of [undefined, ...FILE_TRANSFER_STAGES]) {
            const outcome = describeFileTransfer({
              ...(failedAt === undefined ? {} : { failedAt }),
              socketRead,
              cleanup,
              usage,
            })

            expect(CHECK_STATES).toContain(outcome.state)
            expect(String(outcome.result).length).toBeGreaterThan(10)
            // A failed stage is never reported as anything but a failure.
            if (failedAt !== undefined) {
              expect(outcome.state).toBe('fail')
            }
          }
        }
      }
    }
  })
})

describe('the two witnesses a check cannot stand in for', () => {
  const ready: WitnessTransport = { state: 'READY', operations: ['SYNC_ITEMS', 'FILES_V1'], deferred: false }
  const board = (input: Parameters<typeof buildWitnessBoard>[0]) => buildWitnessBoard(input)

  /**
   * *** NEGOTIATED IS NOT CROSSED. *** `sync-items` is the socket agreeing to
   * carry sync. `durable-sync` is a sync having gone over it and come back, which
   * is the only observation that the gateway and the syncing server hold the same
   * secret.
   */
  it('confirms the durable lane only on a sync that crossed it', () => {
    const crossed = board({ checks: [], transport: ready, syncRounds: { socket: 1, http: 0, failed: 0 } })
    const notYet = board({ checks: [], transport: ready, syncRounds: { socket: 0, http: 3, failed: 0 } })

    expect(crossed['sync-items'].state).toBe('confirmed')
    expect(crossed['durable-sync'].state).toBe('confirmed')
    // Negotiated, every round so far over HTTP: the socket agreed and nothing has
    // crossed. A check settles it, and the witness names the check.
    expect(notYet['sync-items'].state).toBe('confirmed')
    expect(notYet['durable-sync'].state).toBe('not-run')
    expect(notYet['durable-sync'].how).toBe(howToRun(CHECKS.sync))
  })

  it('does not send the reader back to a check that has already run and did not cross', () => {
    const ran = readingsFrom({ sync: outcome('sync', 'degraded') })
    const witnesses = board({ checks: ran, transport: ready, syncRounds: { socket: 0, http: 4, failed: 0 } })

    expect(witnesses['durable-sync'].state).toBe('unknown')
  })

  it('has nothing to observe where sync does not ride a socket on this tab', () => {
    const rounds = { socket: 0, http: 2, failed: 0 }
    const sibling = board({
      checks: [],
      transport: { state: 'HTTP_FALLBACK', operations: [], deferred: true },
      syncRounds: rounds,
    })
    const httpOnly = board({
      checks: [],
      transport: { state: 'HTTP_ONLY', operations: [], deferred: false },
      syncRounds: rounds,
    })

    expect(sibling['durable-sync'].state).toBe('unavailable')
    expect(httpOnly['durable-sync'].state).toBe('unavailable')
    // And with no counters at all it is a reading that did not arrive.
    expect(board({ checks: [], transport: ready })['durable-sync'].state).toBe('unknown')
  })

  it('reads the socket half of the file round trip, and only that half', () => {
    const states = Object.fromEntries(
      FILE_SOCKET_READS.map((read) => [
        read,
        board({ checks: [], transport: ready, fileSocketRead: read })['file-socket-read'].state,
      ]),
    )

    expect(states).toEqual({
      matched: 'confirmed',
      mismatched: 'refuted',
      failed: 'refuted',
      'not-negotiated': 'unavailable',
      // The check RAN and failed before the socket read. Not "not tested": the
      // reader must not be sent back to run the check that just failed.
      'not-reached': 'unknown',
    })
    const notRun = board({ checks: [], transport: ready })['file-socket-read']
    expect(notRun.state).toBe('not-run')
    expect(notRun.how).toBe(howToRun(CHECKS['file-transfer']))
  })
})

describe('a check that did not pass', () => {
  it('raises a finding with one action for the checks that test a whole path', () => {
    for (const id of ['sync', 'revisions', 'file-transfer'] as const) {
      for (const state of ['fail', 'degraded'] as const) {
        const block = buildChecksBlock(
          'backend',
          readingsFrom({ [id]: outcome(id, state, 'what happened, for the screen') }),
        )
        const finding = block?.findings[0]

        expect({ id, state, findings: block?.findings.length }).toEqual({ id, state, findings: 1 })
        expect(finding?.verdict).toBe(CHECK_STATE_VERDICT[state])
        expect(finding?.evidence.kind).toBe('direct')
        expect((finding?.remedy?.summary ?? '').length).toBeGreaterThan(40)
        // The check's own detail is the reasoning on screen, verbatim.
        expect(finding?.detail).toBe('what happened, for the screen')
      }
    }
  })

  it('raises nothing for a check that passed, has not run, or had nothing to test', () => {
    for (const state of ['pass', 'unknown', 'not-applicable'] as const) {
      const block = buildChecksBlock('backend', readingsFrom({ 'file-transfer': outcome('file-transfer', state) }))

      expect({ state, findings: block?.findings.length }).toEqual({ state, findings: 0 })
    }
    expect(buildChecksBlock('backend', readingsFrom({}))?.findings).toEqual([])
  })

  it('keeps its copy in this build: no part of a remedy is the check’s screen-only detail', () => {
    const planted = 'https://files.internal.example/?token=hunter2'
    const block = buildChecksBlock(
      'backend',
      readingsFrom({ 'file-transfer': outcome('file-transfer', 'fail', planted) }),
    )
    const remedy = block?.findings[0]?.remedy

    expect(JSON.stringify(remedy)).not.toContain('hunter2')
    expect(JSON.stringify(remedy)).not.toContain('files.internal.example')
  })
})

/* -------------------------------------------------------------------------- */
/* Three build identities, compared two at a time                             */
/* -------------------------------------------------------------------------- */

const OLD_BUILD = 'a'.repeat(40)
const NEW_BUILD = 'b'.repeat(40)
const marker = (revision: string) => ({ revision, version: `src-${revision.slice(0, 12)}` })

describe('describeAppShellCheck', () => {
  it('passes when this tab’s code and the server’s marker name the same commit', () => {
    const outcome = describeAppShellCheck({
      bundleRevision: NEW_BUILD,
      marker: marker(NEW_BUILD),
      markerRead: 'answered',
    })

    expect(outcome.state).toBe('pass')
    expect(String(outcome.result)).toBe('this tab runs the build the server serves')
  })

  /**
   * *** THE STALE SHELL. *** The server has moved on and this tab has not. It is
   * "working, with something lost" — the app runs — and the row names both
   * commits, so the reader can see which is behind.
   */
  it('says the tab is stale, and names both builds, when they differ', () => {
    const outcome = describeAppShellCheck({
      bundleRevision: OLD_BUILD,
      marker: marker(NEW_BUILD),
      markerRead: 'answered',
    })

    expect(outcome.state).toBe('degraded')
    expect(String(outcome.result)).toBe(`stale: this tab runs ${OLD_BUILD} and the server serves ${NEW_BUILD}`)
    expect(outcome.detail).toContain('Fixes in the newer build are not running here')
  })

  it('does not call a bundle with no revision a match, or a mismatch', () => {
    for (const bundleRevision of ['', 'unstamped', 'abc123', NEW_BUILD.toUpperCase()]) {
      const outcome = describeAppShellCheck({ bundleRevision, marker: marker(NEW_BUILD), markerRead: 'answered' })

      expect({ bundleRevision, state: outcome.state }).toEqual({ bundleRevision, state: 'unknown' })
      expect(String(outcome.result)).toBe('this tab’s code carries no build revision')
    }
  })

  it('has nothing to compare with when the server names no build, and leaves that fact to the marker check', () => {
    const unstamped = describeAppShellCheck({
      bundleRevision: NEW_BUILD,
      marker: { revision: 'unstamped', version: 'unstamped' },
      markerRead: 'answered',
    })
    const unread = describeAppShellCheck({ bundleRevision: NEW_BUILD, marker: {}, markerRead: 'failed' })

    for (const outcome of [unstamped, unread]) {
      expect(outcome.state).toBe('not-applicable')
      expect(readingOf(outcome.result)).toBe('unavailable')
    }
  })

  it('admits a revision by shape only, so a marker cannot put text into the result', () => {
    const planted = 'https://deploy.internal.example/?token=hunter2'
    const outcome = describeAppShellCheck({
      bundleRevision: OLD_BUILD,
      marker: { revision: planted, version: planted },
      markerRead: 'answered',
    })

    expect(String(outcome.result)).not.toContain('hunter2')
    expect(outcome.detail).not.toContain('hunter2')
    expect(outcome.state).toBe('not-applicable')
  })
})

describe('describeServerBuildCheck', () => {
  const ready = (revision: string) => ({ status: 200, body: { status: 'ready', deployment: marker(revision) } })

  it('passes when the web app and the API server name the same commit', () => {
    const outcome = describeServerBuildCheck({
      marker: marker(NEW_BUILD),
      markerRead: 'answered',
      readiness: ready(NEW_BUILD),
    })

    expect(outcome.state).toBe('pass')
    expect(String(outcome.result)).toBe('same build')
  })

  it('says the two are different builds, and names both, when they are', () => {
    const outcome = describeServerBuildCheck({
      marker: marker(NEW_BUILD),
      markerRead: 'answered',
      readiness: ready(OLD_BUILD),
    })

    expect(outcome.state).toBe('degraded')
    expect(String(outcome.result)).toBe(`different builds: web app ${NEW_BUILD} · server ${OLD_BUILD}`)
  })

  it('reads a server that says it is not ready as not working, and a missing route as unknown', () => {
    const notReady = describeServerBuildCheck({
      marker: marker(NEW_BUILD),
      markerRead: 'answered',
      readiness: { status: 503, body: { status: 'not-ready' } },
    })
    const absent = describeServerBuildCheck({
      marker: marker(NEW_BUILD),
      markerRead: 'answered',
      readiness: { status: 404, body: {} },
    })

    expect(notReady.state).toBe('fail')
    expect(String(notReady.result)).toBe('readiness answered HTTP 503')
    expect(absent.state).toBe('unknown')
  })

  it('says which side names no build, and claims no match either way', () => {
    const serverSilent = describeServerBuildCheck({
      marker: marker(NEW_BUILD),
      markerRead: 'answered',
      readiness: { status: 200, body: { status: 'ready', deployment: { revision: 'unstamped' } } },
    })
    const noBody = describeServerBuildCheck({
      marker: marker(NEW_BUILD),
      markerRead: 'answered',
      readiness: { status: 200, body: null },
    })
    const webSilent = describeServerBuildCheck({ marker: {}, markerRead: 'failed', readiness: ready(NEW_BUILD) })

    expect(serverSilent.state).toBe('unknown')
    expect(noBody.state).toBe('unknown')
    expect(String(serverSilent.result)).toBe('the server names no build')
    expect(webSilent.state).toBe('not-applicable')
  })

  it('admits the server’s revision by shape only', () => {
    const planted = 'redis://admin:hunter2@redis.internal.example:6379'
    const outcome = describeServerBuildCheck({
      marker: marker(NEW_BUILD),
      markerRead: 'answered',
      readiness: { status: 200, body: { status: 'ready', deployment: { revision: planted, version: planted } } },
    })

    expect(JSON.stringify(outcome)).not.toContain('hunter2')
    expect(outcome.state).toBe('unknown')
  })
})

describe('a build that is behind', () => {
  it('raises one finding each, with something to do about it', () => {
    const stale = buildChecksBlock(
      'environment',
      readingsFrom({
        'app-shell': {
          id: 'app-shell',
          ...describeAppShellCheck({ bundleRevision: OLD_BUILD, marker: marker(NEW_BUILD), markerRead: 'answered' }),
        },
        'server-build': {
          id: 'server-build',
          ...describeServerBuildCheck({
            marker: marker(NEW_BUILD),
            markerRead: 'answered',
            readiness: { status: 200, body: { status: 'ready', deployment: marker(OLD_BUILD) } },
          }),
        },
      }),
    )

    expect(stale?.findings.map((finding) => String(finding.code))).toEqual([
      'APP_SHELL_STALE',
      'WEB_AND_SERVER_BUILDS_DIFFER',
    ])
    expect(stale?.findings[0]?.remedy?.summary).toContain('Reload this tab')
    expect(stale?.findings[0]?.remedy?.summary).toContain('clears program files only and none of your data')
    expect(stale?.findings[1]?.remedy?.summary).toContain('from the same commit')
    for (const finding of stale?.findings ?? []) {
      expect(finding.verdict).toBe('degraded')
    }
  })
})
