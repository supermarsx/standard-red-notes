import { ContentType } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import { AssistantTools, AssistantToolContext } from './tools'
import { readPrivateNoteComments, mutatePrivateNoteComments } from '@/Comments/PrivateNoteComments'
import { readDisplayNoteComments } from '@/Comments/CommentAuthorship'
import { captureAssistantCommentTarget } from '@/Comments/CommentTargets'
import type { NoteComment } from '@/Comments/comments'

jest.mock('@/Comments/PrivateNoteComments', () => ({
  readPrivateNoteComments: jest.fn(),
  mutatePrivateNoteComments: jest.fn(),
}))
jest.mock('@/Comments/CommentAuthorship', () => ({
  ...jest.requireActual('@/Comments/CommentAuthorship'),
  readDisplayNoteComments: jest.fn(),
}))
jest.mock('@/Comments/CommentTargets', () => ({ captureAssistantCommentTarget: jest.fn() }))
jest.mock('@/Components/SuperEditor/Collaboration/CollaborationKeyDerivation', () => ({
  ...jest.requireActual('@/Components/SuperEditor/Collaboration/CollaborationKeyDerivation'),
  resolveNoteEncryptionIdentity: () => ({
    noteUuid: 'note',
    userUuid: 'self',
    sourceId: 'source',
    sessionUser: { uuid: 'self' },
    keySystemIdentifier: null,
    sharedVaultUuid: null,
  }),
}))

function harness(overrides: Partial<AssistantToolContext> = {}) {
  const user = { uuid: 'self', email: 'self@example.test' }
  const note = {
    uuid: 'note',
    title: 'Selected note',
    text: 'Body',
    content_type: ContentType.TYPES.Note,
    user_uuid: 'self',
    locked: false,
    trashed: false,
  }
  let privateComments: NoteComment[] = []
  let shared: NoteComment[] = []
  const assertCurrent = jest.fn()
  jest.mocked(captureAssistantCommentTarget).mockReturnValue({ anchor: undefined, assertCurrent })
  jest.mocked(readPrivateNoteComments).mockImplementation(() => privateComments)
  jest.mocked(mutatePrivateNoteComments).mockImplementation(async (_app, _uuid, update) => {
    privateComments = update(privateComments)
  })
  jest.mocked(readDisplayNoteComments).mockImplementation(() => ({
    quarantinedCount: 0,
    comments: shared.map((comment) => ({
      ...comment,
      authorshipStatus: 'verified',
      verifiedAuthorUuid: comment.authorUuid,
      displayAuthorName: comment.authorName,
    })),
  }))
  const controller = {
    upsertNoteComment: jest.fn(async (_note: unknown, comment: NoteComment) => {
      shared = [...shared.filter((old) => old.id !== comment.id), comment]
      return { comment, mutation: {} }
    }),
    removeNoteComment: jest.fn(async () => ({})),
    setNoteCommentResolved: jest.fn(async () => ({})),
    purgeNoteComments: jest.fn(async () => []),
  }
  const application = {
    sessions: { getUser: () => user, isCurrentSessionReadOnly: () => false },
    items: { findItem: (uuid: string) => (uuid === 'note' ? note : undefined) },
    isAuthorizedToRenderItem: () => true,
    vaults: { getItemVault: () => undefined },
    notesController: controller,
    mutator: { changeItem: jest.fn() },
  } as unknown as WebApplication
  const requestConfirmation = jest.fn().mockResolvedValue(true)
  const tools = new AssistantTools(application, {
    confirmBeforeWrite: false,
    requestConfirmation,
    presentPane: () => {},
    ...overrides,
  })
  return {
    tools,
    application,
    note,
    user,
    controller,
    assertCurrent,
    requestConfirmation,
    private: () => privateComments,
    shared: () => shared,
    seedPrivate: (comments: NoteComment[]) => {
      privateComments = comments
    },
    seedShared: (comments: NoteComment[]) => {
      shared = comments
    },
  }
}

const comment = (id = 'comment', authorUuid = 'self'): NoteComment => ({
  id,
  authorUuid,
  authorName: 'Author',
  text: 'Original',
  createdAt: '2026-10-16T00:00:00.000Z',
})
const add = { noteUuid: 'note', visibility: 'private', action: 'add', target: 'note', text: 'Remember @self' }
beforeEach(() => jest.clearAllMocks())

it('keeps private additions encrypted in personal preferences and resolves @self without notifying others', async () => {
  const h = harness()
  await expect(h.tools.call('comments.manage', add)).resolves.toMatchObject({ ok: true, visibility: 'private' })
  expect(h.private()[0].text).toContain('(self)')
  expect(h.private()[0].mentions).toBeUndefined()
  expect(h.controller.upsertNoteComment).not.toHaveBeenCalled()
  expect(h.application.mutator.changeItem).not.toHaveBeenCalled()
  expect(h.assertCurrent).toHaveBeenCalledWith({ sharedMutation: false })
  await expect(h.tools.call('comments.manage', { ...add, notifyOthers: true })).rejects.toThrow(
    'Private comments cannot notify',
  )
})

it('uses signed controller persistence for shared comments and only notifies when explicitly requested', async () => {
  const h = harness()
  await h.tools.call('comments.manage', { ...add, visibility: 'collaborative' })
  expect(h.shared()[0].mentions).toBeUndefined()
  await h.tools.call('comments.manage', { ...add, visibility: 'collaborative', notifyOthers: true })
  expect(h.shared().at(-1)?.mentions).toEqual(['all-note-members', 'self'])
  expect(h.controller.upsertNoteComment).toHaveBeenCalledTimes(2)
  expect(h.assertCurrent).toHaveBeenCalledWith({ sharedMutation: true })
})

it.each(['selection', 'section', 'checklist'] as const)(
  'uses the actual captured %s anchor and propagates unavailable selection errors',
  async (target) => {
    const h = harness()
    const anchor = { kind: 'checklist' as const, todoId: 'actual-todo' }
    jest.mocked(captureAssistantCommentTarget).mockReturnValue({ anchor, assertCurrent: h.assertCurrent })
    await h.tools.call('comments.manage', { ...add, target, todoId: 'actual-todo' })
    expect(h.private()[0].anchor).toEqual(anchor)
    expect(captureAssistantCommentTarget).toHaveBeenCalledWith(h.application, 'note', target, 'actual-todo')
    jest.mocked(captureAssistantCommentTarget).mockImplementation(() => {
      throw new Error('Select text in the live editor first')
    })
    await expect(h.tools.call('comments.manage', { ...add, target })).rejects.toThrow(
      'Select text in the live editor first',
    )
  },
)

it('supports private replies, edits, resolution/reopen and thread deletion without affecting shared comments', async () => {
  const h = harness()
  h.seedPrivate([comment()])
  h.seedShared([comment('shared')])
  await h.tools.call('comments.manage', { ...add, action: 'reply', commentId: 'comment', text: 'Reply' })
  expect(h.private()[1].parentId).toBe('comment')
  await h.tools.call('comments.manage', { ...add, action: 'edit', commentId: 'comment', text: 'Edited' })
  expect(h.private().find((c) => c.id === 'comment')?.text).toBe('Edited')
  for (const action of ['resolve', 'reopen']) {
    await h.tools.call('comments.manage', { noteUuid: 'note', visibility: 'private', action, commentId: 'comment' })
    expect(h.private().find((c) => c.id === 'comment')?.resolved === true).toBe(action === 'resolve')
  }
  await h.tools.call('comments.manage', {
    noteUuid: 'note',
    visibility: 'private',
    action: 'delete',
    commentId: 'comment',
  })
  expect(h.private()).toEqual([])
  expect(h.shared()).toHaveLength(1)
})

it('enforces selected-note scope, author edits, owner moderation, and read-only session boundaries', async () => {
  const h = harness({ selectedNoteUuids: new Set() })
  await expect(h.tools.call('comments.list', { noteUuid: 'note', visibility: 'private' })).rejects.toThrow(
    'outside the context',
  )
  const other = harness()
  other.seedShared([comment('other', 'someone-else')])
  await expect(
    other.tools.call('comments.manage', { ...add, visibility: 'collaborative', action: 'edit', commentId: 'other' }),
  ).rejects.toThrow('verified comment author')
  other.note.user_uuid = 'someone-else'
  await expect(
    other.tools.call('comments.manage', {
      noteUuid: 'note',
      visibility: 'collaborative',
      action: 'delete',
      commentId: 'other',
    }),
  ).rejects.toThrow('comment author or note owner')
  other.application.sessions.isCurrentSessionReadOnly = () => true
  await expect(other.tools.call('comments.manage', add)).rejects.toThrow('read-only')
})

it('always confirms destructive purges even when other tool approvals are bypassed, and supports denial', async () => {
  const h = harness({ shouldRequestConfirmation: () => false })
  h.seedPrivate([comment()])
  h.requestConfirmation.mockResolvedValueOnce(false)
  await expect(
    h.tools.call('comments.manage', { noteUuid: 'note', visibility: 'private', action: 'purge-mine' }),
  ).resolves.toMatchObject({ cancelled: true })
  expect(h.private()).toHaveLength(1)
  await h.tools.call('comments.manage', { noteUuid: 'note', visibility: 'private', action: 'purge-all' })
  expect(h.private()).toEqual([])
  expect(h.requestConfirmation).toHaveBeenCalledTimes(2)
})

it('returns separate bounded visibility pages without attestations and rejects missing visibility', async () => {
  const h = harness()
  h.seedPrivate([comment('private')])
  h.seedShared([comment('shared')])
  const result = await h.tools.call('comments.list', { noteUuid: 'note', visibility: 'private', limit: 1 })
  expect(result).toMatchObject({ visibility: 'private', total: 1, comments: [{ id: 'private' }] })
  expect(JSON.stringify(result)).not.toContain('signingPublicKey')
  expect(JSON.stringify(result)).not.toContain('shared')
  await expect(h.tools.call('comments.list', { noteUuid: 'note' })).rejects.toThrow('visibility explicitly')
})

it('fails closed when a live room cannot mutate or the controller cannot acknowledge persistence', async () => {
  const h = harness()
  h.assertCurrent.mockImplementation(() => {
    throw new Error('Waiting for a socket saver; retry')
  })
  await expect(h.tools.call('comments.manage', { ...add, visibility: 'collaborative' })).rejects.toThrow('socket saver')
  expect(h.controller.upsertNoteComment).not.toHaveBeenCalled()
  h.assertCurrent.mockReset()
  h.controller.upsertNoteComment.mockResolvedValueOnce(undefined as never)
  await expect(h.tools.call('comments.manage', { ...add, visibility: 'collaborative' })).rejects.toThrow(
    'durably acknowledged',
  )
})

it('rechecks session identity inside a delayed private mutation rather than writing for a replacement session', async () => {
  const h = harness()
  jest.mocked(mutatePrivateNoteComments).mockImplementationOnce(async (_application, _uuid, update) => {
    h.application.sessions.getUser = () => ({ ...h.user }) as never
    update([])
  })
  await expect(h.tools.call('comments.manage', add)).rejects.toThrow('comment session changed')
  expect(h.private()).toEqual([])
  expect(h.controller.upsertNoteComment).not.toHaveBeenCalled()
})

it('withholds comment mutations from read-only agents and prevents nonowners purging shared threads', async () => {
  const h = harness({ allowMutatingTools: false })
  await expect(h.tools.call('comments.manage', add)).rejects.toThrow('Unknown tool')
  const nonowner = harness()
  nonowner.note.user_uuid = 'another-account'
  await expect(
    nonowner.tools.call('comments.manage', { noteUuid: 'note', visibility: 'collaborative', action: 'purge-all' }),
  ).rejects.toThrow('note or shared-vault owner')
  expect(nonowner.controller.purgeNoteComments).not.toHaveBeenCalled()
})
