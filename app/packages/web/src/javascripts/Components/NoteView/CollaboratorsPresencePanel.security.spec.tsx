/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

const mockApplication = {
  vaultUsers: {
    getSharedVaultUsersFromServer: jest.fn(),
  },
  sessions: {
    getUser: jest.fn(),
    isSignedIn: jest.fn(),
  },
  contacts: {
    findContactForServerUser: jest.fn(),
  },
  vaultLocks: {
    isVaultLocked: jest.fn(),
    getUnlockedSharedVaultRootKey: jest.fn(),
  },
  sockets: {
    isWebSocketConnectionOpen: jest.fn(),
  },
}

const mockVault = {
  isSharedVaultListing: () => true,
}

let mockCollaborationAccess: { status: 'disabled'; reason: string } | { status: 'preparing' } | { status: 'ready' }

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => mockApplication,
}))

jest.mock('@/Hooks/useItemVaultInfo', () => ({
  useItemVaultInfo: () => ({ vault: mockVault }),
}))

jest.mock('../SuperEditor/Collaboration/useCollaborationRoomAccess', () => ({
  useCollaborationRoomAccess: () => mockCollaborationAccess,
}))

import { SUPER_COLLABORATION_TRANSPORT_REASON } from '../SuperEditor/Collaboration/CollaborationAvailability'
import CollaboratorsPresencePanel from './CollaboratorsPresencePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  mockApplication.vaultUsers.getSharedVaultUsersFromServer.mockResolvedValue([
    { user_uuid: 'self-uuid' },
    { user_uuid: 'peer-uuid' },
  ])
  mockApplication.sessions.getUser.mockReturnValue({ uuid: 'self-uuid' })
  mockApplication.sessions.isSignedIn.mockReturnValue(true)
  mockApplication.vaultLocks.isVaultLocked.mockReturnValue(false)
  mockApplication.vaultLocks.getUnlockedSharedVaultRootKey.mockReturnValue({ uuid: 'root-key' })
  mockApplication.sockets.isWebSocketConnectionOpen.mockReturnValue(false)
  mockApplication.contacts.findContactForServerUser.mockImplementation((member: { user_uuid: string }) => {
    return member.user_uuid === 'peer-uuid' ? { name: 'Peer' } : undefined
  })
  mockCollaborationAccess = {
    status: 'disabled',
    reason: SUPER_COLLABORATION_TRANSPORT_REASON,
  }

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(window as { enableSuperCollaboration?: boolean }).enableSuperCollaboration = true
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  delete (window as { enableSuperCollaboration?: boolean }).enableSuperCollaboration
})

it('truthfully reports collaboration as paused while the encrypted gateway is offline', async () => {
  await act(async () => {
    root.render(createElement(CollaboratorsPresencePanel, { item: { uuid: 'note-uuid' } as never }))
  })

  expect(container.textContent).toContain('live collaboration paused')
  expect(container.textContent).toContain(SUPER_COLLABORATION_TRANSPORT_REASON)
  expect(container.textContent).not.toContain('online')
})

it('updates its wording when the reactive collaboration access changes', async () => {
  await act(async () => {
    root.render(createElement(CollaboratorsPresencePanel, { item: { uuid: 'note-uuid' } as never }))
  })
  expect(container.textContent).toContain('live collaboration paused')

  mockCollaborationAccess = { status: 'ready' }
  await act(async () => {
    root.render(createElement(CollaboratorsPresencePanel, { item: { uuid: 'note-uuid' } as never }))
  })

  expect(container.textContent).toContain(
    'End-to-end encrypted live editing and presence are active for collaborators with edit permission.',
  )
  expect(container.textContent).not.toContain('live collaboration paused')
})
