/**
 * @jest-environment jsdom
 *
 * Proves the placement the user asked for: the encrypted-collaboration icon sits
 * in the title bar's status row IMMEDIATELY BEFORE the note sync status, and
 * disappears cleanly when collaboration does not apply.
 *
 * This is a real DOM-order assertion, not a snapshot: deleting the chip from the
 * cluster, or reordering the two children, turns this suite red.
 */
import { act, createElement, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'

const mockApplication = {
  setPreference: jest.fn(),
  sync: { sync: jest.fn() },
  sessions: { getUser: () => ({ uuid: 'self-uuid', email: 'me@example.com' }) },
  vaultUsers: { getSharedVaultUsersFromServer: jest.fn() },
  contacts: { findContactForServerUser: () => undefined },
  preferences: { getLocalValue: (_key: string, fallback: unknown) => fallback, setLocalValue: jest.fn() },
  addEventObserver: () => () => undefined,
}

jest.mock('../ApplicationProvider', () => ({
  useApplication: () => mockApplication,
}))

// The note is in no vault here: the cluster is about ORDER, and the collaboration
// control's own suite covers what a shared note adds to it.
jest.mock('@/Hooks/useItemVaultInfo', () => ({
  useItemVaultInfo: () => ({ vault: undefined }),
}))

jest.mock('../Popover/Popover', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: ReactNode }) => {
    return open ? createElement('div', null, children) : null
  },
}))

import { CollaborationStatusRegistry } from '../SuperEditor/Collaboration/CollaborationStatusRegistry'
import { COLLABORATION_INDICATOR_TEST_ID } from './CollaborationStatusIndicator'
import NoteStatusCluster from './NoteStatusCluster'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOM = 'note-uuid'
const note = { uuid: ROOM, lastSyncEnd: undefined } as never

let container: HTMLElement
let root: Root

const renderCluster = async (): Promise<void> => {
  await act(async () => {
    root.render(
      createElement(NoteStatusCluster, {
        note,
        status: { type: 'saved', message: 'All changes saved' },
        syncTakingTooLong: false,
        updateSavingIndicator: true,
      }),
    )
  })
}

beforeEach(() => {
  CollaborationStatusRegistry.clearRoom(ROOM)
  window.matchMedia = ((query: string) => ({
    matches: query === '(min-width: 768px)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  })) as unknown as typeof window.matchMedia
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  CollaborationStatusRegistry.clearRoom(ROOM)
})

it('renders the collaboration icon immediately before the sync status', async () => {
  CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })

  await renderCluster()

  const buttons = Array.from(container.querySelectorAll('button'))
  expect(buttons).toHaveLength(2)

  const collaboration = container.querySelector(`[data-testid="${COLLABORATION_INDICATOR_TEST_ID}"]`)
  const sync = buttons.find((button) => button.textContent?.includes('Note sync status'))

  expect(collaboration).toBeInstanceOf(Element)
  expect(sync).toBeDefined()
  expect(buttons[0]).toBe(collaboration)
  expect(buttons[1]).toBe(sync)

  // DOCUMENT_POSITION_FOLLOWING === 4: `sync` comes after `collaboration`.

  expect((collaboration as HTMLElement).compareDocumentPosition(sync as HTMLElement) & 4).toBe(4)
})

it('leaves the sync status alone when collaboration does not apply', async () => {
  await renderCluster()

  const buttons = Array.from(container.querySelectorAll('button'))
  expect(container.querySelector(`[data-testid="${COLLABORATION_INDICATOR_TEST_ID}"]`)).toBeNull()
  expect(buttons).toHaveLength(1)
  expect(buttons[0].textContent).toContain('Note sync status')
})

it('is the only thing the cluster adds — the sync status keeps its own accessible name', async () => {
  CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })

  await renderCluster()

  const collaboration = container.querySelector(`[data-testid="${COLLABORATION_INDICATOR_TEST_ID}"]`)
  expect(collaboration?.getAttribute('aria-label')).toContain('Encrypted collaboration')
  expect(collaboration?.textContent).not.toContain('Note sync status')
})
