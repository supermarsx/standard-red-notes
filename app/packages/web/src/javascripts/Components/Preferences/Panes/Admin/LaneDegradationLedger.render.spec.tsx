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

const liveTransport = async () => {
  const transport = new WebSocketSyncTransport({
    controlPlane: controlPlane(),
    getConfiguredWebSocketUrl: () => 'wss://sync.example.test',
    getAuthenticatedSessionScope: async () => SESSION,
    deviceId: 'device-1',
    workerFactory: () => worker as unknown as never,
    environment: { hasWorker: true, hasWebSocket: true, hasIndexedDb: true },
    isHttpOnly: () => false,
  })
  // Creates the worker, so the STATE messages below have somewhere to land.
  void transport.execute(syncRequest(), jest.fn().mockResolvedValue(httpResponse()))
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
    expect(rowValue('Transition 1')).toBe('HTTP_FALLBACK multi-tab-not-owner socket torn down under 1s')
    expect(rowValue('Transition 3')).toBe('READY not reported socket torn down under 1s')
    // The lane is back, so the row is a statement rather than a fault.
    expect(rowChip('Where the lane ended up')).toBe('Info')
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
    expect(rowValue('Transition 2')).toBe('DEGRADED server-kill socket torn down under 1s')
  })

  it('emits no SVG, so the block cannot acquire an unmapped icon unnoticed', async () => {
    const transport = await liveTransport()
    worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'server-kill' })
    await flush()

    await renderLedgerOf(transport)

    expect(container.querySelectorAll('svg')).toHaveLength(0)
  })
})
