/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: RENDER + reachability guard for the non-admin "Sync
 * connection" readout (t99).
 *
 * The whole point of this section is that a NON-ADMIN can find out which
 * transport carries their saves — the admin Diagnostics tab already showed it,
 * but the Admin pane is not even in the preferences menu without the ADMIN_USER
 * role. A readout that typechecks but never appears would reproduce the exact
 * failure it exists to fix, and this repo has shipped invisible preferences UI
 * before. So this spec mounts the REAL <General> pane and proves the readout is
 * reachable in its default subtab, not merely that the leaf renders.
 *
 * No @testing-library in this package; React is driven directly with
 * react-dom/client createRoot + act, mirroring ReloadApp.render.spec.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

import type { SyncNegotiatedOperation, SyncTransportState } from '@/Services/SyncTransport/syncTransportProtocol'

type Status = {
  state: SyncTransportState
  fallbackReason?: 'operation-unavailable' | 'proxy-failed'
  operations: readonly SyncNegotiatedOperation[]
}

let transportStatus: Status | undefined

const application = {
  get syncTransportStatus() {
    return transportStatus
  },
} as unknown as import('@/Application/WebApplication').WebApplication

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => application,
}))

// Siblings in the General subtab pull in unrelated service surface; the
// composition under test is this pane's own.
jest.mock('./Language', () => ({ __esModule: true, default: () => createElement('div', null, 'LANGUAGE') }))
jest.mock('./Persistence', () => ({ __esModule: true, default: () => createElement('div', null, 'PERSISTENCE') }))
jest.mock('./TimezonePreference', () => ({ __esModule: true, default: () => createElement('div', null, 'TIMEZONE') }))
jest.mock('./Updates', () => ({ __esModule: true, default: () => createElement('div', null, 'UPDATES') }))
jest.mock('./ReloadApp', () => ({ __esModule: true, default: () => createElement('div', null, 'RELOAD') }))

import SyncConnection from './SyncConnection'
import General from './General'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  transportStatus = undefined
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

const renderLeaf = async () => {
  await act(async () => {
    root.render(createElement(SyncConnection, { application }))
  })
  await act(async () => {})
}

const renderPane = async () => {
  await act(async () => {
    root.render(createElement(General))
  })
  await act(async () => {})
}

describe('the non-admin Sync connection readout', () => {
  it('reports the websocket, and the negotiated sync, when the socket carries saves', async () => {
    transportStatus = { state: 'READY', operations: ['SYNC_ITEMS', 'INVITE_EVENTS'] }
    await renderLeaf()

    const text = container.textContent ?? ''
    expect(text).toContain('Sync connection')
    expect(text).toContain('WebSocket')
    expect(text).toContain('Note syncing is running over the websocket.')
  })

  it('reports HTTP and the reason when the socket negotiated everything BUT sync', async () => {
    transportStatus = {
      state: 'HTTP_FALLBACK',
      fallbackReason: 'operation-unavailable',
      operations: ['AUTHORIZE_COLLABORATION', 'API_RPC'],
    }
    await renderLeaf()

    const text = container.textContent ?? ''
    // The reason, and its plain-language meaning, both surface for a non-admin.
    expect(text).toContain('operation-unavailable')
    expect(text).toContain('did not negotiate the operation this request needed')
    expect(text).toContain('each save is one request')
  })

  it('renders without a transport installed at all', async () => {
    transportStatus = undefined
    await renderLeaf()

    expect(container.textContent ?? '').toContain('Sync connection')
  })

  it('is REACHABLE in the real General pane default subtab', async () => {
    transportStatus = { state: 'READY', operations: ['SYNC_ITEMS'] }
    await renderPane()

    const panel = container.querySelector('[role="tabpanel"]')
    expect(panel).not.toBeNull()
    // Sibling sentinels prove this is the General subtab, not another one.
    expect(panel?.textContent).toContain('TIMEZONE')
    expect(panel?.textContent).toContain('Sync connection')
    expect(panel?.textContent).toContain('Note syncing is running over the websocket.')
  })

  it('follows a transport that changes while the pane stays open', async () => {
    jest.useFakeTimers()
    try {
      transportStatus = { state: 'READY', operations: ['SYNC_ITEMS'] }
      await act(async () => {
        root.render(createElement(SyncConnection, { application }))
      })
      await act(async () => {})
      expect(container.textContent ?? '').toContain('Note syncing is running over the websocket.')

      transportStatus = { state: 'HTTP_FALLBACK', fallbackReason: 'proxy-failed', operations: [] }
      await act(async () => {
        jest.advanceTimersByTime(2500)
      })
      await act(async () => {})

      const text = container.textContent ?? ''
      expect(text).toContain('proxy-failed')
      expect(text).toContain('each save is one request')
    } finally {
      jest.useRealTimers()
    }
  })
})
