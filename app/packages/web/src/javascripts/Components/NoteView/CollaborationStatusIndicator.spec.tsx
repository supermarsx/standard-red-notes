/**
 * @jest-environment jsdom
 *
 * The encrypted-collaboration state used to REPLACE the whole editing surface
 * with a "Preparing encrypted collaboration…" panel. It now lives entirely in
 * this 20px status chip, so this suite is the proof that no information was lost
 * on the way: every state the old panel could show must still be reachable here,
 * and must be reachable by a screen reader through the chip's accessible name.
 *
 * State is driven through the REAL registries rather than mocked hooks, so this
 * exercises the actual publish -> subscribe -> render path the Super editor uses.
 */
import { act, createElement, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('../Popover/Popover', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement('div', { 'data-testid': 'collaboration-popover' }, children) : null,
}))

import { CollaborationStatusRegistry } from '../SuperEditor/Collaboration/CollaborationStatusRegistry'
import { PresenceRegistry } from '../SuperEditor/Collaboration/PresenceRegistry'
import CollaborationStatusIndicator, {
  COLLABORATION_INDICATOR_TEST_ID,
  PREPARING_QUIET_PERIOD_MS,
  PREPARING_STAND_DOWN_MS,
} from './CollaborationStatusIndicator'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOM = 'note-uuid'

let container: HTMLElement
let root: Root

const chip = (): HTMLElement | null => container.querySelector(`[data-testid="${COLLABORATION_INDICATOR_TEST_ID}"]`)
const label = (): string | null | undefined => chip()?.getAttribute('aria-label')

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(createElement(CollaborationStatusIndicator, { noteUuid: ROOM }))
  })
}

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  CollaborationStatusRegistry.clearRoom(ROOM)
  PresenceRegistry.clearRoom(ROOM)
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
  PresenceRegistry.clearRoom(ROOM)
  jest.useRealTimers()
})

describe('when collaboration does not apply', () => {
  it('renders nothing at all for a note no Super editor owns', async () => {
    await render()

    expect(chip()).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('stays silent on a deployment where collaboration is simply unavailable', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, {
      kind: 'unavailable',
      reason: 'Live collaboration is offline and will retry when the encrypted gateway reconnects.',
    })

    await render()
    await advance(PREPARING_QUIET_PERIOD_MS * 4)

    expect(chip()).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('does not flicker for a first preparation that resolves inside the quiet period', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'preparing' })
    await render()

    expect(chip()).toBeNull()

    await advance(PREPARING_QUIET_PERIOD_MS - 1)
    expect(chip()).toBeNull()

    await act(async () => {
      CollaborationStatusRegistry.setStatus(ROOM, { kind: 'unavailable', reason: 'Sign in to use live collaboration.' })
    })
    await advance(PREPARING_QUIET_PERIOD_MS * 4)

    expect(chip()).toBeNull()
  })

  it('stands down instead of spinning forever when a first preparation never settles', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'preparing' })
    await render()

    await advance(PREPARING_QUIET_PERIOD_MS)
    expect(chip()).not.toBeNull()

    // The gateway answers 503 SYNC_DISABLED and preparation never resolves.
    await advance(PREPARING_STAND_DOWN_MS)

    expect(chip()).toBeNull()

    // And it stays quiet rather than reappearing.
    await advance(PREPARING_STAND_DOWN_MS * 5)
    expect(chip()).toBeNull()
  })

  it('never stands down a reconnect — a room that was live keeps reporting', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()

    await act(async () => {
      CollaborationStatusRegistry.setStatus(ROOM, { kind: 'preparing' })
    })
    await advance(PREPARING_STAND_DOWN_MS * 5)

    expect(chip()).not.toBeNull()
    expect(label()).toContain('Reconnecting')
  })
})

describe('states the removed editor panel used to own', () => {
  it('reports a slow first preparation once it outlasts the quiet period', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'preparing' })
    await render()
    expect(chip()).toBeNull()

    await advance(PREPARING_QUIET_PERIOD_MS)

    expect(chip()).not.toBeNull()
    expect(label()).toBe('Preparing encrypted collaboration. You can keep editing.')
  })

  it('reports an active encrypted room, and names who is editing', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()

    expect(label()).toBe('Encrypted collaboration active. No one else is editing this note right now.')

    await act(async () => {
      PresenceRegistry.setPeers(ROOM, [
        { clientId: 1, name: 'Ada', color: '#ff0000' },
        { clientId: 2, name: 'Grace', color: '#00ff00' },
      ])
    })

    expect(label()).toBe('Encrypted collaboration active. 2 collaborators editing now: Ada, Grace')
  })

  it('changes its accessible name as the room moves between states', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()
    const activeLabel = label()

    await act(async () => {
      CollaborationStatusRegistry.setStatus(ROOM, { kind: 'preparing' })
    })
    const reconnectingLabel = label()

    await act(async () => {
      CollaborationStatusRegistry.setStatus(ROOM, {
        kind: 'unavailable',
        reason: 'The collaboration room epoch changed while collaboration was reconnecting.',
      })
    })
    const failedLabel = label()

    expect(activeLabel).toContain('active')
    expect(reconnectingLabel).toBe('Reconnecting encrypted collaboration. Your edits are still being saved.')
    expect(failedLabel).toBe(
      'Encrypted collaboration unavailable. The collaboration room epoch changed while collaboration was reconnecting.',
    )
    expect(new Set([activeLabel, reconnectingLabel, failedLabel]).size).toBe(3)
  })

  it('shows a reconnect immediately — a room that was live does not wait out the quiet period', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()

    await act(async () => {
      CollaborationStatusRegistry.setStatus(ROOM, { kind: 'preparing' })
    })

    expect(chip()).not.toBeNull()
    expect(label()).toContain('Reconnecting')
  })

  it('surfaces a failure in the status area, with the reason, once collaboration had been live', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()

    await act(async () => {
      CollaborationStatusRegistry.setStatus(ROOM, {
        kind: 'unavailable',
        reason: 'The server did not authorize live editing for this note. Edit permission is required.',
      })
    })

    const button = chip()
    expect(button).not.toBeNull()
    expect(label()).toContain('The server did not authorize live editing for this note.')

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const popover = container.querySelector('[data-testid="collaboration-popover"]')
    expect(popover?.textContent).toContain('Encrypted collaboration unavailable')
    expect(popover?.textContent).toContain('Edit permission is required.')
  })
})

describe('as a status chip', () => {
  it('is icon-only but never label-less', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()

    const button = chip()
    expect(button?.tagName).toBe('BUTTON')
    expect(button?.textContent).toBe('')
    expect(button?.getAttribute('aria-label')).toBeTruthy()
    expect(button?.querySelector('svg')).not.toBeNull()
  })

  it('matches the sync indicator chip geometry so the status row reads as one row', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()

    const className = chip()?.getAttribute('class') ?? ''
    expect(className).toContain('h-5')
    expect(className).toContain('w-5')
    expect(className).toContain('rounded-full')
  })
})
