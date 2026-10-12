/**
 * @jest-environment jsdom
 *
 * The lane-degradation ledger, from a REAL transport to the REAL renderer.
 *
 * MEMORY: verify UI render paths. `yarn tsc` green does not mean a block appears —
 * this repo has twice shipped admin UI that typechecked, tested clean and never
 * reached the screen. So this drives `WebSocketSyncTransport` through an actual
 * degradation-and-recovery sequence with a fake worker, hands its ledger to
 * `buildWebsocketSection`, renders the result with `DiagnosticsSection`, and reads
 * the text an operator would read. Nothing in between is stubbed: a producer that
 * records nothing, a section that drops the block, or a renderer that paints an
 * empty table all fail HERE, and only here.
 *
 * There is no `@testing-library/react` in this package; the harness is
 * `react-dom/client` + `act`, matching `DiagnosticsSection.render.spec.tsx`.
 * `DiagnosticsSection` touches no media query and no native-mobile bridge, so it
 * needs no stub beyond the act environment.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

import { LANE_LEDGER_TRANSITION_CAPACITY, LaneDegradationLedger } from '@/Services/SyncTransport/LaneDegradationLedger'
import { SyncTransportControlPlane, WebSocketSyncTransport } from '@/Services/SyncTransport/WebSocketSyncTransport'
import type { MainToSyncWorkerMessage, SyncWorkerToMainMessage } from '@/Services/SyncTransport/syncTransportProtocol'
import type { AccountSyncTransportRequest } from '@standardnotes/services'
import type { HttpResponse, RawSyncResponse } from '@standardnotes/snjs'

import DiagnosticsSection from './DiagnosticsSection'
import { buildWebsocketSection } from './websocketSection'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeWorker {
  onmessage: ((event: MessageEvent<SyncWorkerToMainMessage>) => void) | null = null
  onerror: (() => void) | null = null
  posts: MainToSyncWorkerMessage[] = []

  postMessage(message: MainToSyncWorkerMessage): void {
    this.posts.push(message)
  }

  emit(message: SyncWorkerToMainMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<SyncWorkerToMainMessage>)
  }

  terminate(): void {
    /* nothing to tear down in the double */
  }
}

const SESSION = `sync-session-v1:${'a'.repeat(64)}`

const syncRequest = (): AccountSyncTransportRequest => ({
  api: '20240226',
  items: [],
  sync_token: 'token',
  limit: 150,
})

const httpResponse = () =>
  ({
    status: 200,
    data: { retrieved_items: [], saved_items: [], sync_token: 'next' },
  }) as unknown as HttpResponse<RawSyncResponse>

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

let container: HTMLElement
let root: Root
let worker: FakeWorker

const controlPlane = (): SyncTransportControlPlane => ({
  getCapabilities: jest.fn().mockResolvedValue({ capabilities: [{ id: 'ws-sync', version: 1, endpoint: '/s' }] }),
  createTicket: jest.fn().mockResolvedValue({
    ticket: 'ticket'.repeat(8),
    expiresAt: Date.now() + 30_000,
    endpoint: '/sockets/sync',
    capability: 'ws-sync',
    version: 1,
  }),
})

const liveTransport = async (options: { startSync?: boolean } = {}) => {
  const transport = new WebSocketSyncTransport({
    controlPlane: controlPlane(),
    getConfiguredWebSocketUrl: () => 'wss://sync.example.test',
    getAuthenticatedSessionScope: async () => SESSION,
    deviceId: 'device-1',
    workerFactory: () => worker as unknown as never,
    environment: { hasWorker: true, hasWebSocket: true, hasIndexedDb: true },
    isHttpOnly: () => false,
  })
  // Creates the worker, so the STATE messages below have somewhere to land. A
  // test whose own first request creates it opts out: the transport serialises
  // its requests, and this sync — which no fake worker ever answers — would hold
  // everything behind it.
  if (options.startSync !== false) {
    void transport.execute(syncRequest(), jest.fn().mockResolvedValue(httpResponse()))
  }
  await flush()
  return transport
}

beforeEach(() => {
  worker = new FakeWorker()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const renderLedgerOf = async (transport: WebSocketSyncTransport): Promise<string> => {
  const model = buildWebsocketSection({
    transport: { ...transport.transportStatus, operations: [...transport.transportStatus.operations] },
    ledger: transport.laneDegradationLedger,
  })
  await act(async () => {
    root.render(createElement(DiagnosticsSection, { model }))
  })
  return container.textContent ?? ''
}

const rowValue = (label: string): string | undefined => {
  const row = [...container.querySelectorAll('tr')].find(
    (element) => element.querySelector('td')?.textContent === label,
  )
  return [...(row?.querySelectorAll('td') ?? [])][1]?.textContent ?? undefined
}

const rowChip = (label: string): string | undefined => {
  const row = [...container.querySelectorAll('tr')].find(
    (element) => element.querySelector('td')?.textContent === label,
  )
  return [...(row?.querySelectorAll('span') ?? [])].map((element) => element.textContent ?? '')[0]
}

describe('the lane-degradation ledger on screen', () => {
  it('paints the block, its history and its verdict after a real degradation and recovery', async () => {
    const transport = await liveTransport()

    worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason: 'multi-tab-not-owner' })
    worker.emit({ type: 'STATE', state: 'CONNECTING' })
    worker.emit({ type: 'STATE', state: 'READY' })
    worker.emit({
      type: 'NEGOTIATED',
      sessionScope: SESSION,
      protocolVersion: 1,
      endpoint: 'wss://sync.example.test/sockets/sync',
      operations: ['SYNC_ITEMS'],
    })
    await flush()

    const text = await renderLedgerOf(transport)

    expect(text).toContain('Lane degradation ledger')
    expect(text).not.toContain('This client build records no lane-degradation ledger')
    expect(rowValue('Transport transitions recorded')).toBe('3')
    expect(rowValue('Degradations recorded')).toBe('1')
    expect(rowValue('Recoveries recorded')).toBe('1')
    expect(rowValue('Where the lane ended up')).toBe('recovered')
    expect(rowValue('Transition 1')).toBe('HTTP_FALLBACK multi-tab-not-owner · socket closed · under 1s ago')
    expect(rowValue('Transition 2')).toBe('CONNECTING · no socket yet · under 1s ago')
    expect(rowValue('Transition 3')).toBe('READY · socket up · under 1s ago')
    // The lane is back, so the row is a statement rather than a fault.
    expect(rowChip('Where the lane ended up')).toBe('Info')
    expect(rowChip('Degradations recorded')).toBe('Info')
  })

  /**
   * *** THE OPERATOR'S REPORT, REPRODUCED THROUGH THE REAL TRANSPORT. *** A
   * healthy socket, and one collaboration authorization the worker sent to HTTP
   * because it was busy. On their screen: "Reported fallback reason:
   * reconnect-gap" on a READY transport, "never-degraded" and "Degradations
   * recorded: 0" beside "Recoveries recorded: 2". Nothing here is a fixture of the
   * ledger's view — the worker message goes through `WebSocketSyncTransport`, so
   * the cause is what is under test and not the wording.
   */
  it('shows a healthy socket as one that never fell back when a single request went to HTTP', async () => {
    const transport = await liveTransport({ startSync: false })
    const authorizing = transport.authorizeCollaborationRoom('note-1')
    const posted = () => worker.posts.find((message) => message.type === 'AUTHORIZE_COLLABORATION')
    // The request crosses several awaits before it is posted; wait for the post
    // itself rather than for a number of ticks that happens to be enough today.
    for (let tick = 0; tick < 50 && posted() === undefined; tick++) {
      await flush()
    }
    const open = posted() as Extract<MainToSyncWorkerMessage, { type: 'AUTHORIZE_COLLABORATION' }>
    expect(open).toBeDefined()
    worker.emit({ type: 'STATE', state: 'CONNECTING' })
    worker.emit({ type: 'STATE', state: 'READY' })
    await flush()
    worker.emit({ type: 'COLLABORATION_FALLBACK', clientRequestId: open.clientRequestId, reason: 'reconnect-gap' })
    await flush()
    await authorizing

    await renderLedgerOf(transport)

    expect(rowValue('Transport in use right now')).toBe('READY')
    expect(rowValue('Reported fallback reason')).toBe('nothing to report (the socket is up)')
    expect(rowChip('Reported fallback reason')).toBe('N/A')
    expect(rowValue('Where the lane ended up')).toBe('never-degraded')
    expect(rowValue('Degradations recorded')).toBe('0')
    expect(rowValue('Recoveries recorded')).toBe('0')
    expect(rowValue('Transport transitions recorded')).toBe('2')
    expect(rowValue('Most recent transition')).toBe('READY')
    expect(rowValue('Single requests sent to HTTP on a live socket')).toBe('1')
    expect(rowValue('Single requests sent to HTTP, cause reconnect-gap')).toBe('1')
  })

  /**
   * The case the live rows cannot report. `Transport in use right now` reads
   * HTTP_FALLBACK here too — but that row has read HTTP_FALLBACK for a tab standing
   * down politely as well, and only the history separates the two.
   */
  it('paints a lane that went down and stayed down as degraded', async () => {
    const transport = await liveTransport()

    worker.emit({ type: 'STATE', state: 'READY' })
    worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'server-kill' })
    await flush()

    await renderLedgerOf(transport)

    expect(rowValue('Where the lane ended up')).toBe('still-degraded')
    expect(rowChip('Where the lane ended up')).toBe('Degraded')
  })

  /**
   * Proven on screen, not merely in the model: a lane that flaps for an hour must
   * not paint an unbounded table, and the entries it dropped must be a number the
   * operator can read rather than a silent truncation.
   */
  it('paints a bounded history however long the lane flapped, and prints what it elided', async () => {
    const transport = await liveTransport()

    for (let round = 0; round < 80; round += 1) {
      worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason: 'ack-timeout' })
      worker.emit({ type: 'STATE', state: 'READY' })
    }
    await flush()

    const text = await renderLedgerOf(transport)
    const historyRows = [...container.querySelectorAll('tr')].filter((element) =>
      element.querySelector('td')?.textContent?.startsWith('Transition '),
    )

    expect(historyRows).toHaveLength(LANE_LEDGER_TRANSITION_CAPACITY)
    expect(rowValue('Transitions dropped from the ring')).toBe(String(160 - LANE_LEDGER_TRANSITION_CAPACITY))
    expect(rowChip('Transitions dropped from the ring')).toBe('Degraded')
    // The causes survive the elision, so the ledger still knows what happened even
    // where it no longer knows when.
    expect(rowValue('Degradations with cause ack-timeout')).toBe('80')
    expect(text).toContain('The socket lane has been falling back and recovering repeatedly')
  })

  it('counts a refused control-plane read on screen, under the status it was refused with', async () => {
    const transport = await liveTransport()
    transport.recordControlPlaneRejection(401)
    transport.recordControlPlaneRejection(498)

    const text = await renderLedgerOf(transport)

    expect(rowValue('Control-plane reads the lane refused')).toBe('2')
    expect(rowValue('Control-plane reads refused with 401')).toBe('1')
    expect(rowValue('Refusals on a status this build cannot name')).toBe('0')
    expect(text).toContain('The socket’s control-plane lane refused reads outright')
  })

  /**
   * A reload empties the ledger. Without this row an operator reading "0
   * transitions" four seconds after a reload would conclude the lane had been
   * stable, which is the exact mistake the recording-time row exists to prevent.
   */
  it('says how long it has been watching, so an empty ledger cannot read as a quiet one', async () => {
    let clock = 0
    const quiet = new LaneDegradationLedger({ now: () => clock, baselineState: 'HTTP_ONLY' })
    clock = 2_700_000
    const model = buildWebsocketSection({ ledger: quiet.view() })

    await act(async () => {
      root.render(createElement(DiagnosticsSection, { model }))
    })

    expect(rowValue('This ledger has been recording for')).toBe('45m 0s')
    expect(rowValue('Transport transitions recorded')).toBe('0')
    expect(rowValue('Where the lane ended up')).toBe('not reported')
    expect(rowChip('Where the lane ended up')).toBe('Unknown')
  })

  it('says in words that a build with no ledger records none, rather than painting zeros', async () => {
    const model = buildWebsocketSection({})

    await act(async () => {
      root.render(createElement(DiagnosticsSection, { model }))
    })
    const text = container.textContent ?? ''

    expect(text).toContain('This client build records no lane-degradation ledger')
    expect(text).not.toContain('Where the lane ended up')
    expect(text).not.toContain('Transport transitions recorded')
  })

  it('puts no endpoint, ticket or session scope on the screen', async () => {
    const transport = await liveTransport()
    worker.emit({ type: 'STATE', state: 'READY' })
    worker.emit({
      type: 'NEGOTIATED',
      sessionScope: SESSION,
      protocolVersion: 1,
      endpoint: 'wss://sync.example.test/sockets/sync',
      operations: ['SYNC_ITEMS'],
    })
    worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'server-kill' })
    await flush()

    const text = await renderLedgerOf(transport)

    expect(text).not.toContain('sync.example.test')
    expect(text).not.toContain('sockets/sync')
    expect(text).not.toContain('device-1')
    expect(text).not.toContain(SESSION)
    expect(text).not.toContain('ticketticket')
    // Not vacuous: the block really did render this session's history.
    expect(rowValue('Transition 2')).toBe('DEGRADED server-kill · socket closed · under 1s ago')
  })

  /**
   * The pane used to assert it emitted NO svg at all, because an `Icon` whose
   * name is missing from the mapping renders that name as text inside a `label`
   * and neither tsc nor an `Icon`-mocking spec can see it. Every status now has an
   * icon, so the assertion is the hazard itself: every status chip drew a glyph,
   * and nothing fell back to a label. `Icon` is NOT mocked in this file.
   */
  it('draws a real glyph for every status chip and falls back to a name for none', async () => {
    const transport = await liveTransport()
    worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'server-kill' })
    await flush()

    await renderLedgerOf(transport)

    const chips = Array.from(container.querySelectorAll('[data-diagnostics-status]'))
    expect(chips.length).toBeGreaterThan(10)
    for (const chip of chips) {
      expect(chip.querySelectorAll('svg')).toHaveLength(1)
    }
    expect(container.querySelectorAll('label')).toHaveLength(0)
  })
})
