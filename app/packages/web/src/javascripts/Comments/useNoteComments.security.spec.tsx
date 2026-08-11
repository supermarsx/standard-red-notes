/**
 * @jest-environment jsdom
 */
import { webcrypto } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import type { SNNote } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { useCollaborationRoomAccess } from '@/Components/SuperEditor/Collaboration/useCollaborationRoomAccess'
import { CommentRelay } from './CommentRelay'
import { CommentsApi, useNoteComments } from './useNoteComments'
import { resolveNoteEncryptionIdentity } from '@/Components/SuperEditor/Collaboration/CollaborationKeyDerivation'

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: jest.fn(),
}))

jest.mock('@/Components/SuperEditor/Collaboration/useCollaborationRoomAccess', () => ({
  useCollaborationRoomAccess: jest.fn(),
}))

jest.mock('./CommentRelay', () => ({
  CommentRelay: jest.fn(),
}))

jest.mock('@/Components/SuperEditor/Collaboration/CollaborationKeyDerivation', () => ({
  resolveNoteEncryptionIdentity: jest.fn(),
}))

const mockedUseApplication = jest.mocked(useApplication)
const mockedUseCollaborationRoomAccess = jest.mocked(useCollaborationRoomAccess)
const MockedCommentRelay = jest.mocked(CommentRelay)
const mockedResolveIdentity = jest.mocked(resolveNoteEncryptionIdentity)
const sessionUser = { uuid: 'user-1', email: 'alice@example.test' }

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
    mockedResolveIdentity.mockImplementation((_application, note) => ({
      noteUuid: note.uuid,
      userUuid: sessionUser.uuid,
      sessionUser,
      sourceId: `source:${note.uuid}`,
      keySystemIdentifier: note.key_system_identifier ?? null,
      sharedVaultUuid: note.shared_vault_uuid ?? null,
    }))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('keeps local encrypted persistence available when initial realtime join setup throws', async () => {
    const upsertNoteComment = jest.fn((_note: unknown, created: { id: string }) =>
      Promise.resolve({
        comment: created,
        mutation: {
          commentId: created.id,
          operation: 'upsert',
          affectedCommentIds: [created.id],
          stamp: { counter: 1, actorUuid: 'user-1', eventId: 'upsert-event' },
        },
      }),
    )
    const application = {
      sessions: {
        getUser: () => sessionUser,
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
      noteUuid: 'note-1',
      roomKey: {} as CryptoKey,
      capability: 'exact-note-capability',
      serverUpdatedAtTimestamp: 123,
      userUuid: 'user-1',
      sessionUser,
      sourceId: 'source:note-1',
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
    expect(upsertNoteComment).toHaveBeenCalledWith(note, created, expect.objectContaining({ sessionUser }))
    expect(MockedCommentRelay).toHaveBeenCalledTimes(1)
  })

  it('relays only the exact signed comment returned by the durable controller boundary', async () => {
    const mutation = {
      commentId: 'signed-comment',
      operation: 'upsert' as const,
      affectedCommentIds: ['signed-comment'],
      stamp: { counter: 1, actorUuid: 'untrusted-lww-label', eventId: 'event-1' },
    }
    const upsertNoteComment = jest.fn((_note: unknown, draft: Record<string, unknown>) =>
      Promise.resolve({
        comment: {
          ...draft,
          id: 'signed-comment',
          authorship: { version: 1, signingPublicKey: 'signed-public-key', signature: 'signed-proof' },
        },
        mutation,
      }),
    )
    const application = {
      sessions: { getUser: () => sessionUser },
      items: { streamItems: () => jest.fn() },
      notesController: {
        upsertNoteComment,
        removeNoteComment: jest.fn(),
        setNoteCommentResolved: jest.fn(),
      },
    } as never
    const note = { uuid: 'note-1', getAppDomainValue: () => undefined } as never
    mockedUseApplication.mockReturnValue(application)
    mockedUseCollaborationRoomAccess.mockReturnValue({
      status: 'ready',
      available: true,
      noteUuid: 'note-1',
      roomKey: {} as CryptoKey,
      capability: 'exact-note-capability',
      serverUpdatedAtTimestamp: 123,
      userUuid: 'user-1',
      sessionUser,
      sourceId: 'source:note-1',
      username: 'alice@example.test',
    })
    const relay = {
      broadcastUpsert: jest.fn().mockResolvedValue(undefined),
      broadcastRemove: jest.fn().mockResolvedValue(undefined),
      broadcastResolve: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    }
    MockedCommentRelay.mockImplementation(() => relay as never)

    let commentsApi: CommentsApi | undefined
    const View = () => {
      commentsApi = useNoteComments(note)
      return createElement('div')
    }
    await act(async () => {
      root.render(createElement(View))
      await Promise.resolve()
    })

    let created
    await act(async () => {
      created = await commentsApi!.addComment({ text: 'sign this at the controller boundary' })
    })

    expect(created).toEqual(expect.objectContaining({ id: 'signed-comment', authorship: expect.any(Object) }))
    expect(upsertNoteComment.mock.calls[0][1]).not.toHaveProperty('authorship')
    expect(relay.broadcastUpsert).toHaveBeenCalledWith(created, mutation)
  })

  it('never relays deferred note A mutations through the note B room after a prop switch', async () => {
    let releaseUpsert: (() => void) | undefined
    let releaseRemove: (() => void) | undefined
    let releaseResolve: (() => void) | undefined
    const upsertNoteComment = jest.fn((_note: unknown, created: { id: string }) => {
      return new Promise((resolve) => {
        releaseUpsert = () =>
          resolve({
            comment: created,
            mutation: {
              commentId: created.id,
              operation: 'upsert',
              affectedCommentIds: [created.id],
              stamp: { counter: 2, actorUuid: 'user-1', eventId: 'upsert-event' },
            },
          })
      })
    })
    const removeNoteComment = jest.fn((_note: unknown, id: string) => {
      return new Promise((resolve) => {
        releaseRemove = () =>
          resolve({
            commentId: id,
            operation: 'remove',
            affectedCommentIds: [id],
            stamp: { counter: 3, actorUuid: 'user-1', eventId: 'remove-event' },
          })
      })
    })
    const setNoteCommentResolved = jest.fn((_note: unknown, id: string) => {
      return new Promise((resolve) => {
        releaseResolve = () =>
          resolve({
            commentId: id,
            operation: 'resolve',
            affectedCommentIds: [id],
            resolved: true,
            stamp: { counter: 4, actorUuid: 'user-1', eventId: 'resolve-event' },
          })
      })
    })
    const application = {
      sessions: { getUser: () => sessionUser },
      items: { streamItems: () => jest.fn() },
      notesController: { upsertNoteComment, removeNoteComment, setNoteCommentResolved },
    } as never
    const existingComment = {
      id: 'comment-a',
      authorUuid: 'user-1',
      authorName: 'Alice',
      text: 'note A comment',
      createdAt: new Date(0).toISOString(),
    }
    const noteA = { uuid: 'note-a', getAppDomainValue: () => [existingComment] } as unknown as SNNote
    const noteB = { uuid: 'note-b', getAppDomainValue: () => [] } as unknown as SNNote
    mockedUseApplication.mockReturnValue(application)
    mockedUseCollaborationRoomAccess.mockReturnValue({
      status: 'ready',
      available: true,
      noteUuid: 'note-a',
      roomKey: {} as CryptoKey,
      capability: 'exact-note-capability',
      serverUpdatedAtTimestamp: 123,
      userUuid: 'user-1',
      sessionUser,
      sourceId: 'source:note-a',
      username: 'alice@example.test',
    })
    const relays = new Map<
      string,
      { broadcastUpsert: jest.Mock; broadcastRemove: jest.Mock; broadcastResolve: jest.Mock; destroy: jest.Mock }
    >()
    MockedCommentRelay.mockImplementation((_application, room) => {
      const relay = {
        broadcastUpsert: jest.fn().mockResolvedValue(undefined),
        broadcastRemove: jest.fn().mockResolvedValue(undefined),
        broadcastResolve: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn(),
      }
      relays.set(room, relay)
      return relay as never
    })

    let commentsApi: CommentsApi | undefined
    const View = ({ note }: { note: typeof noteA }) => {
      commentsApi = useNoteComments(note)
      return createElement('div', null, note.uuid)
    }
    await act(async () => {
      root.render(createElement(View, { note: noteA }))
      await Promise.resolve()
    })

    let addWork: Promise<unknown> = Promise.resolve()
    let removeWork: Promise<void> = Promise.resolve()
    let resolveWork: Promise<void> = Promise.resolve()
    act(() => {
      addWork = commentsApi!.addComment({ text: 'deferred A comment' })
      removeWork = commentsApi!.removeComment('comment-a')
      resolveWork = commentsApi!.setResolved('comment-a', true)
    })
    await act(async () => {
      root.render(createElement(View, { note: noteB }))
      await Promise.resolve()
    })
    expect(relays.get('note-a')?.destroy).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseUpsert?.()
      releaseRemove?.()
      releaseResolve?.()
      await Promise.all([addWork, removeWork, resolveWork])
    })

    for (const relay of relays.values()) {
      expect(relay.broadcastUpsert).not.toHaveBeenCalled()
      expect(relay.broadcastRemove).not.toHaveBeenCalled()
      expect(relay.broadcastResolve).not.toHaveBeenCalled()
    }
    expect(upsertNoteComment).toHaveBeenCalledWith(
      noteA,
      expect.objectContaining({ text: 'deferred A comment' }),
      expect.objectContaining({ noteUuid: 'note-a', sessionUser }),
    )
    expect(removeNoteComment).toHaveBeenCalledWith(
      noteA,
      'comment-a',
      expect.objectContaining({ noteUuid: 'note-a', sessionUser }),
    )
    expect(setNoteCommentResolved).toHaveBeenCalledWith(
      noteA,
      'comment-a',
      true,
      expect.objectContaining({ noteUuid: 'note-a', sessionUser }),
    )
  })

  it('broadcasts the exact mutation-boundary comment after a deferred resolve rebase', async () => {
    let releaseResolve: (() => void) | undefined
    const rebasedComment = {
      id: 'comment-1',
      authorUuid: 'user-2',
      authorName: 'Bob',
      text: 'newer remote text',
      createdAt: new Date(0).toISOString(),
      resolved: true,
    }
    const mutation = {
      commentId: 'comment-1',
      operation: 'resolve' as const,
      affectedCommentIds: ['comment-1'],
      resolved: true,
      stamp: { counter: 10, actorUuid: 'user-1', eventId: 'resolve-event' },
    }
    const setNoteCommentResolved = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseResolve = () => resolve({ comment: rebasedComment, mutation })
        }),
    )
    const application = {
      sessions: { getUser: () => sessionUser },
      items: { streamItems: () => jest.fn() },
      notesController: {
        upsertNoteComment: jest.fn(),
        removeNoteComment: jest.fn(),
        setNoteCommentResolved,
      },
    } as never
    const note = {
      uuid: 'note-1',
      getAppDomainValue: () => [{ ...rebasedComment, text: 'older local text', resolved: undefined }],
    } as never
    mockedUseApplication.mockReturnValue(application)
    mockedUseCollaborationRoomAccess.mockReturnValue({
      status: 'ready',
      available: true,
      noteUuid: 'note-1',
      roomKey: {} as CryptoKey,
      capability: 'exact-note-capability',
      serverUpdatedAtTimestamp: 123,
      userUuid: 'user-1',
      sessionUser,
      sourceId: 'source:note-1',
      username: 'alice@example.test',
    })
    const relay = {
      broadcastUpsert: jest.fn().mockResolvedValue(undefined),
      broadcastRemove: jest.fn().mockResolvedValue(undefined),
      broadcastResolve: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    }
    MockedCommentRelay.mockImplementation(() => relay as never)
    let commentsApi: CommentsApi | undefined
    const View = () => {
      commentsApi = useNoteComments(note)
      return createElement('div')
    }
    await act(async () => {
      root.render(createElement(View))
      await Promise.resolve()
    })

    let resolveWork: Promise<void> = Promise.resolve()
    act(() => {
      resolveWork = commentsApi!.setResolved('comment-1', true)
    })
    await act(async () => {
      releaseResolve?.()
      await resolveWork
    })

    expect(relay.broadcastResolve).toHaveBeenCalledWith('comment-1', true, mutation)
  })
})
