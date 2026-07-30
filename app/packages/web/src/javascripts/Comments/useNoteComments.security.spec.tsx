/**
 * @jest-environment jsdom
 */
import { webcrypto } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { useApplication } from '@/Components/ApplicationProvider'
import { useCollaborationRoomAccess } from '@/Components/SuperEditor/Collaboration/useCollaborationRoomAccess'
import { CommentRelay } from './CommentRelay'
import { CommentsApi, useNoteComments } from './useNoteComments'

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: jest.fn(),
}))

jest.mock('@/Components/SuperEditor/Collaboration/useCollaborationRoomAccess', () => ({
  useCollaborationRoomAccess: jest.fn(),
}))

jest.mock('./CommentRelay', () => ({
  CommentRelay: jest.fn(),
}))

const mockedUseApplication = jest.mocked(useApplication)
const mockedUseCollaborationRoomAccess = jest.mocked(useCollaborationRoomAccess)
const MockedCommentRelay = jest.mocked(CommentRelay)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
})

describe('useNoteComments realtime fallback', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('keeps local encrypted persistence available when initial realtime join setup throws', async () => {
    const upsertNoteComment = jest.fn().mockResolvedValue(undefined)
    const application = {
      sessions: {
        getUser: () => ({ uuid: 'user-1', email: 'alice@example.test' }),
      },
      items: {
        streamItems: () => jest.fn(),
      },
      notesController: {
        upsertNoteComment,
        removeNoteComment: jest.fn(),
        setNoteCommentResolved: jest.fn(),
      },
    } as never
    const note = {
      uuid: 'note-1',
      getAppDomainValue: () => undefined,
    } as never
    mockedUseApplication.mockReturnValue(application)
    mockedUseCollaborationRoomAccess.mockReturnValue({
      status: 'ready',
      available: true,
      roomKey: {} as CryptoKey,
      capability: 'exact-note-capability',
      userUuid: 'user-1',
      username: 'alice@example.test',
    })
    MockedCommentRelay.mockImplementation(() => {
      throw new Error('socket closed during initial join')
    })

    let commentsApi: CommentsApi | undefined
    const View = () => {
      commentsApi = useNoteComments(note)
      return createElement('div', null, commentsApi.comments.length)
    }

    await act(async () => {
      root.render(createElement(View))
      await Promise.resolve()
    })
    expect(container.textContent).toBe('0')

    let created
    await act(async () => {
      created = await commentsApi!.addComment({ text: 'persist through normal sync' })
    })

    expect(created).toMatchObject({
      authorUuid: 'user-1',
      authorName: 'alice@example.test',
      text: 'persist through normal sync',
    })
    expect(upsertNoteComment).toHaveBeenCalledWith(note, created)
    expect(MockedCommentRelay).toHaveBeenCalledTimes(1)
  })
})
