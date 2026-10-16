import type { SNNote } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import { readDisplayNoteComments } from '@/Comments/CommentAuthorship'
import { ALL_NOTE_MEMBERS_RECIPIENT } from '@/Comments/CommentPreferences'
import { CommentNotificationReader } from './commentNotifications'

jest.mock('@/Comments/CommentAuthorship', () => ({ readDisplayNoteComments: jest.fn() }))

const sharedNote = { uuid: 'note-a', shared_vault_uuid: 'vault-a', title: 'Planning' } as SNNote
const comment = (overrides = {}) => ({
  id: 'comment-a',
  verifiedAuthorUuid: 'other-user',
  authorshipStatus: 'verified',
  displayAuthorName: 'Collaborator',
  mentions: [ALL_NOTE_MEMBERS_RECIPIENT],
  ...overrides,
})
const application = () => ({
  isAuthorizedToRenderItem: jest.fn(() => true),
  items: { findItem: jest.fn(() => sharedNote) },
  itemListController: { openNote: jest.fn(async () => {}) },
  alerts: { alert: jest.fn() },
})

it('only notifies for signed, unresolved comments addressed to this member or all note members', () => {
  jest.mocked(readDisplayNoteComments).mockReturnValue({
    quarantinedCount: 1,
    comments: [
      comment(),
      comment({ id: 'explicit', mentions: ['self'] }),
      comment({ id: 'quiet', mentions: undefined }),
      comment({ id: 'legacy', authorshipStatus: 'legacy' }),
      comment({ id: 'own', verifiedAuthorUuid: 'self' }),
      comment({ id: 'resolved', resolved: true }),
      comment({ id: 'somebody-else', mentions: ['not-self'] }),
    ],
  } as never)
  const app = application() as unknown as WebApplication
  const notifications = new CommentNotificationReader().read(app, sharedNote, 'self')
  expect(notifications.map((entry) => entry.id)).toEqual([
    'comment:self:note-a:comment-a',
    'comment:self:note-a:explicit',
  ])
  expect(notifications[0]).toMatchObject({
    title: 'New comment',
    subtitle: 'Planning',
    message: 'Collaborator added a comment.',
  })
})

it('does not inspect unauthorized, locked, trashed or personal notes', () => {
  const app = application()
  const reader = new CommentNotificationReader()
  for (const patch of [{ shared_vault_uuid: undefined }, { locked: true }, { trashed: true }]) {
    expect(reader.read(app as unknown as WebApplication, { ...sharedNote, ...patch } as SNNote, 'self')).toEqual([])
  }
  app.isAuthorizedToRenderItem.mockReturnValue(false)
  expect(reader.read(app as unknown as WebApplication, sharedNote, 'self')).toEqual([])
  expect(readDisplayNoteComments).not.toHaveBeenCalled()
})

it('caches expensive verification for immutable notes, invalidates on trust changes and rechecks access on opening', () => {
  jest.mocked(readDisplayNoteComments).mockReturnValue({ quarantinedCount: 0, comments: [comment()] } as never)
  const app = application()
  const reader = new CommentNotificationReader()
  const notifications = reader.read(app as unknown as WebApplication, sharedNote, 'self')
  reader.read(app as unknown as WebApplication, sharedNote, 'self')
  expect(readDisplayNoteComments).toHaveBeenCalledTimes(1)
  reader.invalidate()
  reader.read(app as unknown as WebApplication, sharedNote, 'self')
  expect(readDisplayNoteComments).toHaveBeenCalledTimes(2)
  app.isAuthorizedToRenderItem.mockReturnValue(false)
  notifications[0].action!.run()
  expect(app.itemListController.openNote).not.toHaveBeenCalled()
  app.isAuthorizedToRenderItem.mockReturnValue(true)
  notifications[0].action!.run()
  expect(app.itemListController.openNote).toHaveBeenCalledWith('note-a')
})
