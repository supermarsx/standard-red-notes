/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useApplication } from '@/Components/ApplicationProvider'
import { useNoteComments } from '@/Comments/useNoteComments'
import { usePrivateNoteComments } from '@/Comments/usePrivateNoteComments'
import CommentsPanel from './CommentsPanel'

jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: jest.fn() }))
jest.mock('@/Comments/useNoteComments', () => ({ useNoteComments: jest.fn() }))
jest.mock('@/Comments/usePrivateNoteComments', () => ({ usePrivateNoteComments: jest.fn() }))
jest.mock('@/Comments/useMentionCandidates', () => ({ useMentionCandidates: jest.fn(() => []) }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('./CommentComposer', () => ({
  __esModule: true,
  default: ({ onSubmit }: { onSubmit: (text: string) => void }) => (
    <button onClick={() => onSubmit('Test comment')}>Submit test comment</button>
  ),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('defaults to private without preparing shared room access, explicitly opts into collaboration, and resets targets to private', async () => {
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
  expect(shared.addComment).toHaveBeenCalled()
  jest.mocked(useNoteComments).mockClear()
  // A legacy task ID may equal the whole-note sentinel; its scope must still reset.
  const anchor = { kind: 'checklist' as const, todoId: 'note', snippet: 'Task' }
  await act(async () => root.render(<CommentsPanel note={note} anchor={anchor} />))
  expect(container.querySelector('[role="combobox"]')?.textContent).toContain('Private — only you')
  expect(useNoteComments).not.toHaveBeenCalled()
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit test comment')!.click(),
  )
  expect(personal.addComment).toHaveBeenLastCalledWith({ text: 'Test comment', parentId: undefined, anchor })
  await act(async () => root.unmount())
  container.remove()
})
