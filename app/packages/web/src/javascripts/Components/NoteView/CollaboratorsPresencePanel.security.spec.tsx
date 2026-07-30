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
  },
  contacts: {
    findContactForServerUser: jest.fn(),
  },
}

const mockVault = {
  isSharedVaultListing: () => true,
}

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => mockApplication,
}))

jest.mock('@/Hooks/useItemVaultInfo', () => ({
  useItemVaultInfo: () => ({ vault: mockVault }),
}))

import { SUPER_COLLABORATION_UNAVAILABLE_REASON } from '../SuperEditor/Collaboration/CollaborationAvailability'
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
  mockApplication.contacts.findContactForServerUser.mockImplementation((member: { user_uuid: string }) => {
    return member.user_uuid === 'peer-uuid' ? { name: 'Peer' } : undefined
  })

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

it('truthfully reports security-gated collaboration even when the legacy flag is forced', async () => {
  await act(async () => {
    root.render(createElement(CollaboratorsPresencePanel, { item: { uuid: 'note-uuid' } as never }))
  })

  expect(container.textContent).toContain('collaboration unavailable')
  expect(container.textContent).toContain(SUPER_COLLABORATION_UNAVAILABLE_REASON)
  expect(container.textContent).not.toContain('online')
})
