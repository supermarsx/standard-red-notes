/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useApplication } from '@/Components/ApplicationProvider'
import { useNoteComments } from '@/Comments/useNoteComments'
import { usePrivateNoteComments } from '@/Comments/usePrivateNoteComments'
import CommentsPanel from './CommentsPanel'
import { useMentionCandidates } from '@/Comments/useMentionCandidates'
let mockPrivateHintDismissed = true

jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: jest.fn() }))
jest.mock('@/Comments/useNoteComments', () => ({ useNoteComments: jest.fn() }))
jest.mock('@/Comments/usePrivateNoteComments', () => ({ usePrivateNoteComments: jest.fn() }))
jest.mock('@/Comments/useMentionCandidates', () => ({ useMentionCandidates: jest.fn(() => []) }))
jest.mock('@/Hooks/usePreference', () => ({
  __esModule: true,
  default: (key: string) => (key === 'commentPrivateHintDismissed' ? mockPrivateHintDismissed : true),
}))
jest.mock('@/Comments/CommentAuthorship', () => ({ readDisplayNoteComments: () => ({ comments: [] }) }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('./CommentComposer', () => ({
  __esModule: true,
  default: ({
    onSubmit,
    showNotifyOthers,
    defaultNotifyOthers,
  }: {
    onSubmit: (text: string, notify: boolean) => void
    showNotifyOthers?: boolean
    defaultNotifyOthers?: boolean
  }) => (
    <button onClick={() => onSubmit('Test comment', Boolean(showNotifyOthers && defaultNotifyOthers))}>
      Submit test comment
    </button>
  ),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('defaults to private without shared room access, keeps threads visible across draft visibility and target changes, and replies in the original scope', async () => {
  jest.mocked(useMentionCandidates).mockReturnValue([])
  const user = { uuid: 'user-a' }
  jest.mocked(useApplication).mockReturnValue({
    sessions: { getUser: () => user, isCurrentSessionReadOnly: () => false },
    isAuthorizedToRenderItem: () => true,
    vaults: { getItemVault: () => undefined },
  } as never)
  const personal = {
    comments: [],
    quarantinedCount: 0,
    selfUuid: user.uuid,
    addComment: jest.fn(async () => ({ id: 'private' })),
    removeComment: jest.fn(),
    setResolved: jest.fn(),
  }
  const shared = { ...personal, addComment: jest.fn(async () => ({ id: 'shared' })) }
  jest.mocked(usePrivateNoteComments).mockReturnValue(personal as never)
  jest.mocked(useNoteComments).mockReturnValue(shared as never)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const note = { uuid: 'note-a' } as never
  await act(async () => root.render(<CommentsPanel note={note} />))
  expect(useNoteComments).not.toHaveBeenCalled()
  expect(container.querySelector('[role="combobox"]')?.textContent).toContain('Private — only you')
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit test comment')!.click(),
  )
  expect(personal.addComment).toHaveBeenCalledWith({ text: 'Test comment', parentId: undefined, anchor: undefined })
  expect(shared.addComment).not.toHaveBeenCalled()
  await act(async () => (container.querySelector('[role="combobox"]') as HTMLButtonElement).click())
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === 'Collaborative — note members')!
      .click(),
  )
  expect(useNoteComments).toHaveBeenCalled()
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit test comment')!.click(),
  )
  expect(shared.addComment).toHaveBeenCalledWith({
    text: 'Test comment',
    parentId: undefined,
    anchor: undefined,
    notifyOthers: true,
  })
  shared.comments = [
    {
      id: 'thread-a',
      authorUuid: 'user-b',
      verifiedAuthorUuid: 'user-b',
      displayAuthorName: 'Peer',
      authorshipStatus: 'verified',
      text: 'A shared thread',
      createdAt: new Date().toISOString(),
    },
  ] as never
  await act(async () => root.render(<CommentsPanel note={note} />))
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reply')!.click(),
  )
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit test comment')!.click(),
  )
  expect(shared.addComment).toHaveBeenLastCalledWith({
    text: 'Test comment',
    parentId: 'thread-a',
    anchor: undefined,
    notifyOthers: true,
  })
  jest.mocked(useNoteComments).mockClear()
  // A legacy task ID may equal the whole-note sentinel; its scope must still reset.
  const anchor = { kind: 'checklist' as const, todoId: 'note', snippet: 'Task' }
  await act(async () => root.render(<CommentsPanel note={note} anchor={anchor} />))
  expect(container.querySelector('[role="combobox"]')?.textContent).toContain('Collaborative — note members')
  expect(useNoteComments).toHaveBeenCalled()
  expect(container.textContent).toContain('A shared thread')
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit test comment')!.click(),
  )
  expect(shared.addComment).toHaveBeenLastCalledWith({
    text: 'Test comment',
    parentId: undefined,
    anchor,
    notifyOthers: true,
  })
  // Draft visibility is independent of previously stored shared threads.
  await act(async () => (container.querySelector('[role="combobox"]') as HTMLButtonElement).click())
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === 'Private — only you')!
      .click(),
  )
  expect(container.textContent).toContain('A shared thread')
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reply')!.click(),
  )
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit test comment')!.click(),
  )
  expect(shared.addComment).toHaveBeenLastCalledWith({
    text: 'Test comment',
    parentId: 'thread-a',
    anchor: undefined,
    notifyOthers: true,
  })
  await act(async () => root.unmount())
  container.remove()
})

it('uses a readable theme token for the empty state and permanently acknowledges the private explanation in account preferences', async () => {
  mockPrivateHintDismissed = false
  const setPreference = jest.fn()
  jest.mocked(useApplication).mockReturnValue({
    sessions: { getUser: () => ({ uuid: 'user-a' }), isCurrentSessionReadOnly: () => false },
    isAuthorizedToRenderItem: () => true,
    setPreference,
  } as never)
  jest
    .mocked(usePrivateNoteComments)
    .mockReturnValue({ comments: [], quarantinedCount: 0, selfUuid: 'user-a' } as never)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<CommentsPanel note={{ uuid: 'note-b' } as never} />))
    expect(
      [...container.querySelectorAll('div.text-passive-0')]
        .find((node) => node.textContent === 'No comments yet. Start the conversation.')
        ?.classList.contains('text-passive-0'),
    ).toBe(true)
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[aria-label="Don\'t show private comment explanation again"]',
    )!
    await act(async () => dismiss.click())
    expect(setPreference).toHaveBeenCalledWith('commentPrivateHintDismissed', true)
    mockPrivateHintDismissed = true
    await act(async () => root.render(<CommentsPanel note={{ uuid: 'note-b' } as never} />))
    expect(container.textContent).not.toContain('Encrypted in your account.')
  } finally {
    await act(async () => root.unmount())
    mockPrivateHintDismissed = true
  }
})

it('shows private read failures instead of presenting missing history as an empty conversation', async () => {
  jest
    .mocked(useApplication)
    .mockReturnValue({
      sessions: { getUser: () => ({ uuid: 'user-a' }), isCurrentSessionReadOnly: () => false },
      isAuthorizedToRenderItem: () => true,
    } as never)
  jest.mocked(usePrivateNoteComments).mockReturnValue({
    comments: [],
    quarantinedCount: 0,
    selfUuid: 'user-a',
    readError: 'Private history is unavailable.',
  } as never)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<CommentsPanel note={{ uuid: 'note-b' } as never} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Private history is unavailable.')
    expect(container.textContent).not.toContain('No comments yet.')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
