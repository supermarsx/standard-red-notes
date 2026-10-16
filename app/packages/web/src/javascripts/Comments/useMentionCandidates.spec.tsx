/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useMentionCandidates } from './useMentionCandidates'
import type { SNNote, SharedVaultUserServerHash } from '@standardnotes/snjs'

let mockUser = { uuid: 'self' }
let mockVault = { uuid: 'listing-a', sharing: { sharedVaultUuid: 'vault-a' }, isSharedVaultListing: () => true }
const mockRead = jest.fn()
const mockApplication = {
  sessions: { getUser: () => mockUser },
  vaultUsers: { getSharedVaultUsersFromServer: mockRead },
  contacts: { findContactForServerUser: (member: SharedVaultUserServerHash) => ({ name: member.user_uuid }) },
}
jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: () => mockApplication }))
jest.mock('@/Hooks/useItemVaultInfo', () => ({ useItemVaultInfo: () => ({ vault: mockVault }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function deferred() {
  let resolve!: (members: SharedVaultUserServerHash[] | undefined) => void
  let reject!: (failure: Error) => void
  const promise = new Promise<SharedVaultUserServerHash[] | undefined>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const members = (uuid: string) => [{ user_uuid: uuid }] as SharedVaultUserServerHash[]

beforeEach(() => {
  mockUser = { uuid: 'self' }
  mockVault = { uuid: 'listing-a', sharing: { sharedVaultUuid: 'vault-a' }, isSharedVaultListing: () => true }
})

it.each(['undefined', 'reject'] as const)(
  'hides the old vault roster during a move and after a %s fetch',
  async (failure) => {
    const first = deferred()
    const second = deferred()
    mockRead.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const element = document.createElement('div')
    const root = createRoot(element)
    const Probe = ({ note }: { note: SNNote }) => (
      <span>
        {useMentionCandidates(note)
          .map((member) => member.userUuid)
          .join(',')}
      </span>
    )
    let note = { uuid: 'note', shared_vault_uuid: 'vault-a' } as SNNote
    try {
      await act(async () => root.render(<Probe note={note} />))
      await act(async () => first.resolve(members('alice')))
      expect(element.textContent).toBe('self,alice')
      mockVault = { uuid: 'listing-b', sharing: { sharedVaultUuid: 'vault-b' }, isSharedVaultListing: () => true }
      note = { uuid: 'note', shared_vault_uuid: 'vault-b' } as SNNote
      await act(async () => root.render(<Probe note={note} />))
      expect(element.textContent).toBe('self')
      await act(async () => {
        if (failure === 'reject') {
          second.reject(new Error('offline'))
        } else {
          second.resolve(undefined)
        }
      })
      expect(element.textContent).toBe('self')
    } finally {
      await act(async () => root.unmount())
    }
  },
)

it('rejects old in-flight results after replacing a session with the same user UUID', async () => {
  const oldRead = deferred()
  const currentRead = deferred()
  mockRead.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(currentRead.promise)
  const element = document.createElement('div')
  const root = createRoot(element)
  const note = { uuid: 'note', shared_vault_uuid: 'vault-a' } as SNNote
  const Probe = () => (
    <span>
      {useMentionCandidates(note)
        .map((member) => member.userUuid)
        .join(',')}
    </span>
  )
  try {
    await act(async () => root.render(<Probe />))
    mockUser = { uuid: 'self' }
    await act(async () => root.render(<Probe />))
    await act(async () => oldRead.resolve(members('old-session-member')))
    expect(element.textContent).toBe('self')
    await act(async () => currentRead.resolve(members('current-member')))
    expect(element.textContent).toBe('self,current-member')
  } finally {
    await act(async () => root.unmount())
  }
})

it('does not carry the old roster across a note encryption-key change', async () => {
  const first = deferred()
  const second = deferred()
  mockRead.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const element = document.createElement('div')
  const root = createRoot(element)
  const Probe = ({ keySystem }: { keySystem: string }) => (
    <span>
      {useMentionCandidates({ uuid: 'note', shared_vault_uuid: 'vault-a', key_system_identifier: keySystem } as SNNote)
        .map((member) => member.userUuid)
        .join(',')}
    </span>
  )
  try {
    await act(async () => root.render(<Probe keySystem="key-a" />))
    await act(async () => first.resolve(members('old-key-member')))
    expect(element.textContent).toBe('self,old-key-member')
    await act(async () => root.render(<Probe keySystem="key-b" />))
    expect(element.textContent).toBe('self')
    await act(async () => second.resolve(members('new-key-member')))
    expect(element.textContent).toBe('self,new-key-member')
  } finally {
    await act(async () => root.unmount())
  }
})
