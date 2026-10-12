/**
 * @jest-environment jsdom
 *
 * The title bar's one collaboration control: the session's status chip, whoever
 * else is in the note beside it, and the popup that says the rest.
 *
 * It took over from three things — the status chip's own popover, a stack of
 * avatars after the sync status, and a bordered "Collaborators" panel under the
 * title bar — so this suite is the proof that nothing they said was lost: every
 * session state is still reachable through the chip's accessible name, everyone
 * the panel listed is still listed, and "paused" is still reported truthfully.
 *
 * State is driven through the REAL registries rather than mocked hooks, so this
 * exercises the actual publish -> subscribe -> render path the Super editor uses.
 * Assertions are on elements, never on a container's text: prose near a control
 * has certified absent controls here before. And an element that must exist is
 * asserted with `toBeInstanceOf(Element)`, never `.not.toBeNull()`: the latter
 * passes on `undefined`, which is what an optional chain yields when the thing it
 * starts from is missing.
 */
import { act, createElement, ReactNode, useEffect, useState } from 'react'
import { createRoot, Root } from 'react-dom/client'

/**
 * Like the real Popover, this keeps its content mounted for an exit animation
 * after `open` goes false. That is the moment focus has to be handed back in: a
 * stand-in that unmounted at once would drop focus to the body by itself and
 * hide whether the control did anything.
 */
jest.mock('../Popover/Popover', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: ReactNode }) => {
    const [isMounted, setIsMounted] = useState(open)
    useEffect(() => {
      if (open) {
        setIsMounted(true)
        return
      }
      const exit = setTimeout(() => setIsMounted(false), 75)
      return () => clearTimeout(exit)
    }, [open])
    return open || isMounted
      ? createElement('div', { 'data-testid': 'collaboration-popover', 'data-open': String(open) }, children)
      : null
  },
}))

const mockLocalPreferences: Record<string, unknown> = {}
const mockPreferenceObservers = new Set<() => void>()

const mockApplication = {
  vaultUsers: {
    getSharedVaultUsersFromServer: jest.fn(),
  },
  sessions: {
    getUser: jest.fn(),
  },
  contacts: {
    findContactForServerUser: jest.fn(),
  },
  preferences: {
    getLocalValue: (key: string, fallback: unknown) => mockLocalPreferences[key] ?? fallback,
    setLocalValue: (key: string, value: unknown) => {
      mockLocalPreferences[key] = value
      mockPreferenceObservers.forEach((observer) => observer())
    },
  },
  addEventObserver: (observer: () => void) => {
    mockPreferenceObservers.add(observer)
    return () => mockPreferenceObservers.delete(observer)
  },
}

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => mockApplication,
}))

let mockVault: { isSharedVaultListing: () => boolean; sharing: { sharedVaultUuid: string } } | undefined

jest.mock('@/Hooks/useItemVaultInfo', () => ({
  useItemVaultInfo: () => ({ vault: mockVault }),
}))

// The panel this replaced mounted the room-access hook just to word a label,
// which authorizes the room and drives awaited syncs a second and third time.
// Nothing in the title bar may do that again.
jest.mock('../SuperEditor/Collaboration/useCollaborationRoomAccess', () => ({
  useCollaborationRoomAccess: () => {
    throw new Error('The title bar must read CollaborationStatusRegistry, not mount useCollaborationRoomAccess.')
  },
}))

import { CollaborationStatusRegistry } from '../SuperEditor/Collaboration/CollaborationStatusRegistry'
import { PresenceRegistry, PresentPeer } from '../SuperEditor/Collaboration/PresenceRegistry'
import { collaboratorColor } from '../SuperEditor/Collaboration/collaboratorColor'
import CollaborationStatusIndicator, {
  COLLABORATION_INDICATOR_TEST_ID,
  PREPARING_QUIET_PERIOD_MS,
  PREPARING_STAND_DOWN_MS,
} from './CollaborationStatusIndicator'
import { CollaboratorAvatarStack } from './CollaboratorAvatars'
import CollaboratorsPopover from './CollaboratorsPopover'
import { Collaborator, describeSession } from './collaborators'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOM = 'note-uuid'
const note = { uuid: ROOM } as never
const COLLAPSED_KEY = 'collaboratorsCollapsed'
const PAUSED_REASON = 'Live collaboration is offline and will retry when the encrypted gateway reconnects.'

let container: HTMLElement
let root: Root
let isDesktop: boolean

const chip = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`[data-testid="${COLLABORATION_INDICATOR_TEST_ID}"]`)
const label = (): string | null | undefined => chip()?.getAttribute('aria-label')
const dot = (): HTMLElement | null => chip()?.querySelector<HTMLElement>('[data-collaboration-status-dot]') ?? null
const avatars = (): HTMLElement[] =>
  Array.from(chip()?.querySelectorAll<HTMLElement>('[data-collaborator-avatars] > [data-collaborator-avatar]') ?? [])
const overflow = (): HTMLElement | null => chip()?.querySelector<HTMLElement>('[data-collaborator-overflow]') ?? null
const count = (): HTMLElement | null => chip()?.querySelector<HTMLElement>('[data-collaborator-count]') ?? null
/** The popup while it is open. One that is closed but still fading out is `fadingPopup()`. */
const popup = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-open="true"] [role="dialog"]')
const fadingPopup = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-open="false"] [role="dialog"]')
const rows = (): HTMLElement[] => Array.from(popup()?.querySelectorAll<HTMLElement>('ul > li') ?? [])
const row = (key: string): HTMLElement | undefined => rows().find((li) => li.dataset.collaborator === key)
const statusOf = (key: string): string | null | undefined =>
  row(key)?.querySelector('[data-collaborator-status]')?.textContent
const roleOf = (key: string): string | null | undefined =>
  row(key)?.querySelector('[data-collaborator-role]')?.textContent
const collapseButton = (): HTMLButtonElement | null =>
  popup()?.querySelector<HTMLButtonElement>('[data-collaborators-collapse]') ?? null
const guards = (): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-collaborators-focus-guard]'))

const rgb = (hex: string): string => {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`
}

const peers = (howMany: number): PresentPeer[] =>
  Array.from({ length: howMany }, (_, index) => ({
    clientId: index + 1,
    userUuid: `peer-${index + 1}`,
    name: `Person ${index + 1}`,
    color: collaboratorColor(`peer-${index + 1}`),
  }))

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(createElement(CollaborationStatusIndicator, { note }))
  })
}

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
}

const click = async (element: Element | null): Promise<void> => {
  expect(element).toBeInstanceOf(Element)
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const press = async (element: Element | null, key: string, shiftKey = false): Promise<void> => {
  expect(element).toBeInstanceOf(Element)
  await act(async () => {
    element?.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
  })
}

const setPeers = async (present: PresentPeer[]): Promise<void> => {
  await act(async () => {
    PresenceRegistry.setPeers(ROOM, present)
  })
}

/** A shared vault of the signed-in admin, two editors (one a trusted contact) and a reader. */
const shareTheNote = (): void => {
  mockVault = { isSharedVaultListing: () => true, sharing: { sharedVaultUuid: 'vault-1' } }
  mockApplication.vaultUsers.getSharedVaultUsersFromServer.mockResolvedValue([
    { user_uuid: 'self-uuid', permission: 'admin' },
    { user_uuid: 'peer-1', permission: 'write' },
    { user_uuid: 'peer-2', permission: 'write' },
    { user_uuid: 'reader', permission: 'read' },
  ])
  mockApplication.contacts.findContactForServerUser.mockImplementation((member: { user_uuid: string }) => {
    return member.user_uuid === 'peer-1' ? { name: 'Ada Lovelace' } : undefined
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  CollaborationStatusRegistry.clearRoom(ROOM)
  PresenceRegistry.clearRoom(ROOM)
  for (const key of Object.keys(mockLocalPreferences)) {
    delete mockLocalPreferences[key]
  }
  mockPreferenceObservers.clear()
  mockVault = undefined
  mockApplication.vaultUsers.getSharedVaultUsersFromServer.mockReset().mockResolvedValue([])
  mockApplication.sessions.getUser.mockReset().mockReturnValue({ uuid: 'self-uuid', email: 'me@example.com' })
  mockApplication.contacts.findContactForServerUser.mockReset().mockReturnValue(undefined)
  isDesktop = true
  window.matchMedia = ((query: string) => ({
    matches: query === '(min-width: 768px)' ? isDesktop : false,
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
  PresenceRegistry.clearRoom(ROOM)
  jest.useRealTimers()
})

describe('when collaboration does not apply', () => {
  it('renders nothing at all for a note no Super editor owns and nobody shares', async () => {
    await render()

    expect(chip()).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('stays silent on a deployment where collaboration is simply unavailable', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'unavailable', reason: PAUSED_REASON })

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
    expect(chip()).toBeInstanceOf(Element)

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

    expect(chip()).toBeInstanceOf(Element)
    expect(label()).toContain('Reconnecting')
  })
})

describe('the session states, in the chip and at the top of the popup', () => {
  it('reports a slow first preparation once it outlasts the quiet period', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'preparing' })
    await render()
    expect(chip()).toBeNull()

    await advance(PREPARING_QUIET_PERIOD_MS)

    expect(chip()).toBeInstanceOf(Element)
    expect(label()).toBe('Preparing encrypted collaboration. You can keep editing.')
  })

  it('reports an active encrypted room, and counts and names who is in it', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()

    expect(label()).toBe('Encrypted collaboration active. No one else is in this note right now.')

    await setPeers([
      { clientId: 1, name: 'Ada', color: '#ff0000' },
      { clientId: 2, name: 'Grace', color: '#00ff00' },
    ])

    expect(label()).toBe('Encrypted collaboration active. 2 collaborators here now: Ada, Grace.')
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

    expect(chip()).toBeInstanceOf(Element)
    expect(label()).toContain('Reconnecting')
    expect(dot()?.dataset.collaborationStatusDot).toBe('warning')
  })

  it('puts a failure, with its reason, at the top of the popup once collaboration had been live', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()

    await act(async () => {
      CollaborationStatusRegistry.setStatus(ROOM, {
        kind: 'unavailable',
        reason: 'The server did not authorize live editing for this note. Edit permission is required.',
      })
    })

    expect(label()).toContain('The server did not authorize live editing for this note.')

    await click(chip())

    const session = popup()?.firstElementChild
    expect(session?.getAttribute('data-collaboration-session')).toBe('warning')
    expect(session?.querySelector('.font-bold')?.textContent).toBe('Encrypted collaboration unavailable')
    expect(session?.textContent).toContain('Edit permission is required.')
  })

  it('shows a room whose automatic retries stood down even if it was never live, and says how it resumes', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, {
      kind: 'unavailable',
      reason: 'The collaboration gateway relay is unavailable right now. Live collaboration will retry.',
      retriesExhausted: true,
    })
    await render()
    await advance(PREPARING_QUIET_PERIOD_MS * 4)

    expect(chip()).toBeInstanceOf(Element)
    expect(label()).toContain('Encrypted collaboration unavailable')
    expect(label()).toContain('relay is unavailable')

    await click(chip())

    const session = popup()?.firstElementChild
    expect(session?.textContent).toContain('Automatic retries have paused')
    expect(session?.textContent).toContain('return to this tab or edit the note')
  })

  it("names the wait for a collaborator's copy and never stands that wait down", async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'preparing', awaitingPeerState: true })
    await render()

    await advance(PREPARING_QUIET_PERIOD_MS)
    expect(chip()).toBeInstanceOf(Element)
    expect(label()).toBe("Waiting for a collaborator's copy of this note. Editing resumes when it arrives.")

    await advance(PREPARING_STAND_DOWN_MS * 2)
    expect(chip()).toBeInstanceOf(Element)

    await act(async () => {
      CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    })
    expect(label()).toContain('Encrypted collaboration active')
  })

  it('says nobody else is here in the popup of a live room that has no list to show', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()
    await click(chip())

    expect(popup()?.querySelector('[data-collaboration-attendance]')?.textContent).toBe(
      'No one else is in this note right now.',
    )
    expect(popup()?.querySelector('ul')).toBeNull()
  })
})

describe('as a status chip', () => {
  it('is a real button, icon-only but never label-less', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()

    const button = chip()
    expect(button?.tagName).toBe('BUTTON')
    expect(button?.getAttribute('type')).toBe('button')
    expect(button?.textContent).toBe('')
    expect(button?.getAttribute('aria-label')).toBeTruthy()
    expect(button?.querySelector('svg')).toBeInstanceOf(Element)
  })

  it('matches the sync indicator chip geometry so the status row reads as one row', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()

    expect(chip()?.className).toContain('h-5')
    const className = dot()?.getAttribute('class') ?? ''
    expect(className).toContain('h-5')
    expect(className).toContain('w-5')
    expect(className).toContain('rounded-full')
  })

  it('draws a glyph, never an icon name as text, in every state — with collaborators present too', async () => {
    // With someone in the room the chip used to ask for an icon that has a type but
    // no glyph, and Icon then prints the name itself, inside a <label>.
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()
    await setPeers(peers(2))

    const states = [
      { kind: 'active' },
      { kind: 'preparing' },
      { kind: 'unavailable', reason: PAUSED_REASON },
      { kind: 'unavailable', reason: PAUSED_REASON, retriesExhausted: true },
    ] as const
    for (const status of states) {
      await act(async () => {
        CollaborationStatusRegistry.setStatus(ROOM, status)
      })
      expect(dot()?.querySelector('svg')).toBeInstanceOf(Element)
      expect(chip()?.querySelector('label')).toBeNull()
    }
  })
})

describe('the collaborators beside the status', () => {
  beforeEach(() => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
  })

  it('takes no room beyond the status chip while nobody else is in the note', async () => {
    await render()

    expect(chip()?.children).toHaveLength(1)
    expect(chip()?.firstElementChild).toBe(dot())
    expect(avatars()).toHaveLength(0)
    expect(count()).toBeNull()
  })

  it('shows one avatar for one collaborator, in their cursor colour, and counts them in the name', async () => {
    await render()
    await setPeers(peers(1))

    expect(avatars()).toHaveLength(1)
    expect(avatars()[0].style.backgroundColor).toBe(rgb(collaboratorColor('peer-1')))
    // One initial in the bar, where the discs overlap; both in the popup, where they do not.
    expect(avatars()[0].textContent).toBe('P')
    expect(overflow()).toBeNull()
    expect(count()).toBeNull()
    expect(label()).toContain('1 collaborator here now: Person 1.')
  })

  it('shows three avatars for three collaborators and no "+N"', async () => {
    await render()
    await setPeers(peers(3))

    expect(avatars().map((avatar) => avatar.dataset.collaboratorAvatar)).toEqual(['peer-1', 'peer-2', 'peer-3'])
    expect(overflow()).toBeNull()
    expect(label()).toContain('3 collaborators here now')
  })

  it('caps at three avatars and folds the other five of eight into "+5"', async () => {
    await render()
    await setPeers(peers(8))

    expect(avatars()).toHaveLength(3)
    expect(overflow()?.textContent).toBe('+5')
    expect(overflow()?.parentElement).toBe(chip()?.querySelector('[data-collaborator-avatars]'))
    expect(label()).toContain('8 collaborators here now: Person 1, Person 2, Person 3 and 5 more.')
  })

  it('is one avatar for a person with the note open in two tabs', async () => {
    await render()
    await setPeers([
      { clientId: 1, userUuid: 'peer-1', name: 'Person 1', color: '#2563eb' },
      { clientId: 2, userUuid: 'peer-1', name: 'Person 1', color: '#2563eb' },
    ])

    expect(avatars()).toHaveLength(1)
    expect(label()).toContain('1 collaborator here now')
  })

  it("does not show the signed-in account's own other tab as a collaborator, but reports it in the popup", async () => {
    await render()
    await setPeers([{ clientId: 9, userUuid: 'self-uuid', name: 'me@example.com', color: '#2563eb' }])

    expect(avatars()).toHaveLength(0)
    expect(count()).toBeNull()
    expect(label()).toBe('Encrypted collaboration active. No one else is in this note right now.')

    await click(chip())

    expect(rows()).toHaveLength(1)
    expect(row('self-uuid')?.dataset.presence).toBe('self')
    expect(statusOf('self-uuid')).toBe('Also open in another tab or device')
  })

  it('never puts the avatars or the count in the accessibility tree as text', async () => {
    await render()
    await setPeers(peers(8))

    expect(chip()?.querySelector('[data-collaborator-avatars]')?.getAttribute('aria-hidden')).toBe('true')
    for (const avatar of avatars()) {
      expect(avatar.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('dims collaborators left over from a room that dropped, instead of showing them as present', async () => {
    await render()
    await setPeers(peers(2))
    expect(chip()?.querySelector('[data-collaborator-avatars]')?.className).not.toContain('opacity-60')

    await act(async () => {
      CollaborationStatusRegistry.setStatus(ROOM, { kind: 'preparing' })
    })

    expect(chip()?.querySelector('[data-collaborator-avatars]')?.className).toContain('opacity-60')
    await click(chip())
    expect(statusOf('peer-1')).toBe('Reconnecting')
  })
})

describe('collapsed, and at phone width', () => {
  beforeEach(() => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
  })

  it('collapses to the status dot with a count, and remembers it under the local preference key', async () => {
    await render()
    await setPeers(peers(8))
    await click(chip())

    expect(collapseButton()?.textContent).toBe('Collapse to a count')
    await click(collapseButton())

    expect(mockLocalPreferences[COLLAPSED_KEY]).toBe(true)
    expect(avatars()).toHaveLength(0)
    expect(chip()?.querySelector('[data-collaborator-avatars]')).toBeNull()
    expect(count()?.textContent).toBe('8')
    expect(count()?.parentElement).toBe(dot())
    expect(collapseButton()?.textContent).toBe('Show avatars in the title bar')
    // The name still carries the count and the names; only the picture changed.
    expect(label()).toContain('8 collaborators here now')

    await click(collapseButton())

    expect(mockLocalPreferences[COLLAPSED_KEY]).toBe(false)
    expect(avatars()).toHaveLength(3)
    expect(count()).toBeNull()
  })

  it('starts collapsed when that is what was stored', async () => {
    mockLocalPreferences[COLLAPSED_KEY] = true
    await render()
    await setPeers(peers(3))

    expect(avatars()).toHaveLength(0)
    expect(count()?.textContent).toBe('3')
  })

  it('treats anything but a stored true as not collapsed', async () => {
    mockLocalPreferences[COLLAPSED_KEY] = 'true'
    await render()
    await setPeers(peers(3))

    expect(avatars()).toHaveLength(3)
    expect(count()).toBeNull()
  })

  it('is just the status chip when collapsed with nobody here', async () => {
    mockLocalPreferences[COLLAPSED_KEY] = true
    await render()

    expect(chip()?.children).toHaveLength(1)
    expect(count()).toBeNull()
    expect(dot()?.className).toContain('w-5')
  })

  it('shrinks to the count below the md breakpoint, where there is nothing to collapse', async () => {
    isDesktop = false
    await render()
    await setPeers(peers(8))

    expect(avatars()).toHaveLength(0)
    expect(count()?.textContent).toBe('8')

    await click(chip())

    expect(rows()).toHaveLength(8)
    expect(collapseButton()).toBeNull()
  })

  it('offers no collapse control when there is nobody whose avatar it could hide', async () => {
    await render()
    await click(chip())

    expect(popup()).toBeInstanceOf(Element)
    expect(collapseButton()).toBeNull()
  })
})

describe('the popup', () => {
  beforeEach(() => {
    shareTheNote()
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
  })

  it('opens from the trigger as a labelled dialog the trigger points at', async () => {
    await render()

    expect(popup()).toBeNull()
    expect(chip()?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(chip()?.getAttribute('aria-expanded')).toBe('false')
    expect(chip()?.hasAttribute('aria-controls')).toBe(false)

    await click(chip())

    expect(popup()?.getAttribute('aria-label')).toBe('Collaborators')
    expect(chip()?.getAttribute('aria-expanded')).toBe('true')
    expect(chip()?.getAttribute('aria-controls')).toBe(popup()?.id)
    expect(popup()?.id).toBeTruthy()
  })

  it('lists every collaborator as a list item with a status and what they may do', async () => {
    await render()
    await setPeers([{ clientId: 1, userUuid: 'peer-2', name: 'grace@example.com', color: '#16a34a' }])
    await click(chip())

    const list = popup()?.querySelector('ul')
    expect(list?.getAttribute('aria-label')).toBe('People with access to this note')
    expect(Array.from(list?.children ?? []).every((child) => child.tagName === 'LI')).toBe(true)
    expect(rows().map((li) => li.dataset.collaborator)).toEqual(['peer-2', 'peer-1', 'reader', 'self-uuid'])

    // In the room: named by what they broadcast, since they are not a trusted contact.
    expect(row('peer-2')?.querySelector('[title]')?.textContent).toBe('grace@example.com')
    expect(statusOf('peer-2')).toBe('In this note')
    expect(roleOf('peer-2')).toBe('Can edit')
    expect(row('peer-2')?.querySelector<HTMLElement>('[data-collaborator-avatar]')?.style.backgroundColor).toBe(
      rgb('#16a34a'),
    )
    expect(row('peer-2')?.querySelector('[data-collaborator-avatar]')?.textContent).toBe('GE')

    // Not in the room: named by trusted contact, and knowably absent because this client is in it.
    expect(row('peer-1')?.querySelector('[title]')?.textContent).toBe('Ada Lovelace')
    expect(statusOf('peer-1')).toBe('Not in this note')
    expect(roleOf('peer-1')).toBe('Can edit')

    // Read-only members never join the room, so nothing is claimed about them.
    expect(statusOf('reader')).toBe('Unknown')
    expect(row('reader')?.querySelector('[data-collaborator-status]')?.getAttribute('title')).toContain(
      'Read-only members do not join live editing',
    )
    expect(roleOf('reader')).toBe('Read-only')

    // The signed-in account, last, with its own role and no presence claim.
    expect(row('self-uuid')?.querySelector('[title]')?.textContent).toBe('You')
    expect(roleOf('self-uuid')).toBe('Admin')
    expect(row('self-uuid')?.querySelector('[data-collaborator-status]')).toBeNull()
  })

  it('puts the session above the list, so there is one place to look', async () => {
    await render()
    await click(chip())

    const [session, list] = Array.from(popup()?.children ?? [])
    expect(session.getAttribute('data-collaboration-session')).toBe('live')
    expect(session.querySelector('.font-bold')?.textContent).toBe('Encrypted collaboration active')
    expect(session.querySelector('svg')).toBeInstanceOf(Element)
    expect(list.tagName).toBe('UL')
  })

  it('reads the roster again each time it opens, so it is current when looked at', async () => {
    await render()
    expect(mockApplication.vaultUsers.getSharedVaultUsersFromServer).toHaveBeenCalledTimes(1)

    await click(chip())
    expect(mockApplication.vaultUsers.getSharedVaultUsersFromServer).toHaveBeenCalledTimes(2)

    await click(chip())
    await click(chip())
    expect(mockApplication.vaultUsers.getSharedVaultUsersFromServer).toHaveBeenCalledTimes(3)
  })
})

describe('a shared note whose live collaboration is not running', () => {
  beforeEach(() => {
    shareTheNote()
  })

  it('is still reachable, quietly, and truthfully reports collaboration as paused with the reason', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'unavailable', reason: PAUSED_REASON })
    await render()

    expect(dot()?.dataset.collaborationStatusDot).toBe('quiet')
    expect(dot()?.querySelector('svg')).toBeInstanceOf(Element)
    expect(avatars()).toHaveLength(0)
    expect(label()).toBe(`Live collaboration paused. ${PAUSED_REASON} 3 other people have access to this note.`)

    await click(chip())

    const session = popup()?.firstElementChild
    expect(session?.querySelector('.font-bold')?.textContent).toBe('Live collaboration paused')
    expect(session?.textContent).toContain(PAUSED_REASON)
    // Nobody is claimed to be here or away: with no live room that cannot be known.
    expect(rows().map((li) => li.dataset.presence)).toEqual(['unknown', 'unknown', 'unknown', 'self'])
    expect(statusOf('peer-1')).toBe('Unknown')
    expect(row('peer-1')?.querySelector('[data-collaborator-status]')?.getAttribute('title')).toContain(
      'Live collaboration is not running',
    )
  })

  it('updates its wording when the session comes up', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'unavailable', reason: PAUSED_REASON })
    await render()
    await click(chip())
    expect(statusOf('peer-1')).toBe('Unknown')

    await act(async () => {
      CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    })

    expect(dot()?.dataset.collaborationStatusDot).toBe('live')
    expect(popup()?.firstElementChild?.querySelector('.font-bold')?.textContent).toBe('Encrypted collaboration active')
    expect(statusOf('peer-1')).toBe('Not in this note')
  })

  it('lists the members of a shared note that no Super editor owns at all', async () => {
    await render()

    expect(dot()?.dataset.collaborationStatusDot).toBe('quiet')
    await click(chip())

    expect(popup()?.firstElementChild?.querySelector('.font-bold')?.textContent).toBe(
      'Live collaboration is not running',
    )
    expect(rows()).toHaveLength(4)
  })

  it('does not spin or flash through the quiet period of a first preparation', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'preparing' })
    await render()

    expect(dot()?.dataset.collaborationStatusDot).toBe('quiet')
    expect(dot()?.querySelector('.animate-spin')).toBeNull()

    await advance(PREPARING_QUIET_PERIOD_MS)
    expect(dot()?.dataset.collaborationStatusDot).toBe('busy')
    expect(dot()?.querySelector('.animate-spin')).toBeInstanceOf(Element)

    await advance(PREPARING_STAND_DOWN_MS)
    expect(dot()?.dataset.collaborationStatusDot).toBe('quiet')
    expect(dot()?.querySelector('.animate-spin')).toBeNull()
    expect(label()).toContain('Live collaboration paused.')
  })

  it('keeps the last roster when a later read fails', async () => {
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
    await render()
    mockApplication.vaultUsers.getSharedVaultUsersFromServer.mockResolvedValue(undefined)

    await click(chip())

    expect(rows()).toHaveLength(4)
  })
})

describe('by keyboard', () => {
  beforeEach(() => {
    shareTheNote()
    CollaborationStatusRegistry.setStatus(ROOM, { kind: 'active' })
  })

  it('moves focus into the popup when it opens', async () => {
    await render()
    chip()?.focus()
    await click(chip())

    expect(document.activeElement).toBe(popup())
  })

  it('closes on Escape from the trigger and leaves focus on it', async () => {
    await render()
    await click(chip())
    chip()?.focus()

    await press(chip(), 'Escape')

    expect(popup()).toBeNull()
    expect(chip()?.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(chip())
  })

  it('hands focus back to the trigger when the popup closes with focus inside it', async () => {
    await render()
    await click(chip())
    expect(document.activeElement).toBe(popup())

    await click(chip())

    expect(popup()).toBeNull()
    // Still in the document, fading out — so nothing but the control moved focus.
    expect(fadingPopup()).toBeInstanceOf(Element)
    expect(document.activeElement).toBe(chip())

    await advance(75)
    expect(fadingPopup()).toBeNull()
    expect(document.activeElement).toBe(chip())
  })

  it('does not take focus back from wherever the user has put it', async () => {
    const editor = document.createElement('input')
    document.body.appendChild(editor)
    await render()
    await click(chip())

    editor.focus()
    await click(chip())

    expect(popup()).toBeNull()
    expect(document.activeElement).toBe(editor)
    editor.remove()
  })

  it('closes and returns to the trigger when Tab steps past either end of the popup', async () => {
    // The popup is portalled, so what follows it in the document is arbitrary. A
    // focusable guard sits immediately before and after it; reaching one is how
    // the browser reports that Tab or Shift+Tab has left the popup.
    await render()
    await setPeers(peers(1))
    await click(chip())

    expect(guards()).toHaveLength(2)
    expect(guards()[0].nextElementSibling).toBe(popup())
    expect(popup()?.nextElementSibling).toBe(guards()[1])
    expect(guards().map((guard) => guard.tabIndex)).toEqual([0, 0])
    // Moving within the popup closes nothing.
    await act(async () => {
      collapseButton()?.focus()
    })
    expect(popup()).toBeInstanceOf(Element)

    // Tab past the last control.
    await act(async () => {
      guards()[1].focus()
    })
    expect(popup()).toBeNull()
    expect(document.activeElement).toBe(chip())

    // Shift+Tab from the top.
    await click(chip())
    await act(async () => {
      guards()[0].focus()
    })
    expect(popup()).toBeNull()
    expect(document.activeElement).toBe(chip())
  })
})

describe('the typing cue', () => {
  // PresenceRegistry does not carry activity yet, so this is rendered from the
  // finished data the indicator would hand over once it does.
  const person = (key: string, presence: Collaborator['presence']): Collaborator => ({
    key,
    name: key,
    color: '#2563eb',
    initials: key.slice(0, 2).toUpperCase(),
    presence,
    isSelf: false,
    isPresent: true,
  })

  it('marks only the avatar of whoever is typing, in the title bar', async () => {
    await act(async () => {
      root.render(
        createElement(CollaboratorAvatarStack, {
          present: [person('ada', 'typing'), person('grace', 'editing')],
          dimmed: false,
        }),
      )
    })

    const [ada, grace] = Array.from(container.querySelectorAll<HTMLElement>('[data-collaborator-avatar]'))
    expect(ada.querySelector('[data-collaborator-typing]')).toBeInstanceOf(Element)
    expect(grace.querySelector('[data-collaborator-typing]')).toBeNull()
    // It must read with motion off: the dot is there, and only its pulse is motion-gated.
    expect(ada.querySelector('[data-collaborator-typing]')?.className).toContain('motion-safe:animate-pulse')
    expect(ada.querySelector('[data-collaborator-typing]')?.className).not.toMatch(/(^|\s)animate-pulse/)
  })

  it('marks the same person in the popup and says so in words', async () => {
    await act(async () => {
      root.render(
        createElement(
          'div',
          { 'data-open': 'true' },
          createElement(CollaboratorsPopover, {
            id: 'popup',
            session: describeSession({ status: { kind: 'active' }, hasBeenActive: true }, 'quiet'),
            attendance: '',
            collaborators: [person('ada', 'typing'), person('grace', 'viewing')],
            collapsed: false,
            onLeave: () => undefined,
          }),
        ),
      )
    })

    expect(row('ada')?.querySelector('[data-collaborator-typing]')).toBeInstanceOf(Element)
    expect(statusOf('ada')).toBe('Typing')
    expect(row('grace')?.querySelector('[data-collaborator-typing]')).toBeNull()
    expect(statusOf('grace')).toBe('Viewing')
  })
})
