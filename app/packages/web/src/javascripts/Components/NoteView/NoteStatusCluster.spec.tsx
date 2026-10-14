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
import type { NoteStatus } from './NoteStatusIndicator'
import * as Y from 'yjs'
import {
  CollaborativeDocumentRegistry,
  documentStateOf,
} from '../SuperEditor/Collaboration/CollaborativeDocumentRegistry'
import { COLLABORATION_ACTIVITY_PULSE_MS } from './useCollaborationActivity'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOM = 'note-uuid'
const note = { uuid: ROOM, lastSyncEnd: undefined } as never

let container: HTMLElement
let root: Root
let removeDocument: (() => void) | undefined
let document: Y.Doc | undefined

const renderCluster = async (
  status: NoteStatus | undefined = { type: 'saved', message: 'All changes saved' },
  syncTakingTooLong = false,
): Promise<void> => {
  await act(async () => {
    root.render(
      createElement(NoteStatusCluster, {
        note,
        status,
        syncTakingTooLong,
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
  container = window.document.createElement('div')
  window.document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  CollaborationStatusRegistry.clearRoom(ROOM)
  removeDocument?.()
  removeDocument = undefined
  document?.destroy()
  document = undefined
  jest.useRealTimers()
})

const establishDocument = () => {
  document = new Y.Doc()
  document.getText('body').insert(0, 'Initial body')
  const liveDocument = document
  removeDocument = CollaborativeDocumentRegistry.set(ROOM, {
    epoch: 'room_epoch_0000000000000001',
    state: () => documentStateOf(liveDocument),
    subscribe: (listener) => {
      liveDocument.on('update', listener)
      return () => liveDocument.off('update', listener)
    },
  })
  CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
  return liveDocument
}

it('pulses actual local and remote changes, including deletion, without spinning for save acknowledgements', async () => {
  jest.useFakeTimers()
  const live = establishDocument()
  await renderCluster()
  const activity = container.querySelector('[data-collaboration-activity]')
  expect(activity).toBeInstanceOf(Element)
  expect(activity?.getAttribute('data-collaboration-activity')).toBe('idle')
  expect(container.querySelector('.animate-spin')).toBeNull()

  await renderCluster({ type: 'saving', message: 'Saving changes' })
  expect(activity?.getAttribute('data-collaboration-activity')).toBe('idle')
  act(() => live.getText('body').insert(0, 'Local '))
  expect(activity?.getAttribute('data-collaboration-activity')).toBe('pulsing')
  act(() => jest.advanceTimersByTime(COLLABORATION_ACTIVITY_PULSE_MS))
  expect(activity?.getAttribute('data-collaboration-activity')).toBe('idle')

  const remote = new Y.Doc()
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(live))
  remote.getText('body').delete(0, 1)
  act(() => Y.applyUpdate(live, Y.encodeStateAsUpdate(remote)))
  expect(activity?.getAttribute('data-collaboration-activity')).toBe('pulsing')
  act(() => jest.advanceTimersByTime(COLLABORATION_ACTIVITY_PULSE_MS))
  await renderCluster({ type: 'saved', message: 'All changes saved' })
  expect(activity?.getAttribute('data-collaboration-activity')).toBe('idle')
  remote.destroy()
})

it('keeps the activity control and focused DOM stable throughout healthy save cycles', async () => {
  establishDocument()
  await renderCluster()
  const activity = container.querySelector('[data-collaboration-activity]')
  const button = activity?.closest('button') as HTMLButtonElement
  button.focus()
  await renderCluster({ type: 'saving', message: 'Saving changes' })
  await renderCluster({ type: 'saved', message: 'All changes saved' })
  expect(container.querySelector('[data-collaboration-activity]')).toBe(activity)
  expect(activity?.closest('button')).toBe(button)
  expect(window.document.activeElement).toBe(button)
  expect(button.classList.contains('h-5')).toBe(true)
  expect(button.classList.contains('w-5')).toBe(true)
})

it('retains errors, delayed saves and offline collaboration states', async () => {
  establishDocument()
  await renderCluster({ type: 'error', message: 'Saving failed' })
  expect(container.querySelector('[data-collaboration-activity]')).toBeNull()
  expect(container.querySelector('.bg-danger')).toBeInstanceOf(Element)
  await renderCluster({ type: 'waiting', message: 'Waiting to save' })
  expect(container.querySelector('[data-collaboration-activity]')).toBeNull()
  expect(container.querySelector('.bg-warning')).toBeInstanceOf(Element)
  await renderCluster({ type: 'saving', message: 'Saving changes' }, true)
  expect(container.querySelector('[data-collaboration-activity]')).toBeNull()
  act(() => CollaborationStatusRegistry.setStatus(ROOM, { kind: 'unavailable', reason: 'Socket unavailable' }))
  await renderCluster({ type: 'saving', message: 'Saving changes' })
  expect(container.querySelector('[data-collaboration-activity]')).toBeNull()
  expect(container.querySelector('.animate-spin')).toBeInstanceOf(Element)
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
