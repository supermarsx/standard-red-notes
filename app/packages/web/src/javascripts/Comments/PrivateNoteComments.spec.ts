import { SNUserPrefs } from '@standardnotes/snjs'
import {
  mutatePrivateNoteComments,
  normalizePrivateComments,
  readPrivateNoteComments,
  MAX_PRIVATE_COMMENT_BYTES,
} from './PrivateNoteComments'
import { NoteComment } from './comments'

const comment = (id: string): NoteComment => ({
  id: `user-a:${id}`,
  authorUuid: 'user-a',
  authorName: 'You',
  text: 'Private task observation',
  createdAt: '2026-10-15T12:00:00.000Z',
})

function fixture() {
  let user = { uuid: 'user-a' }
  let stored: unknown
  const preferences = Object.create(SNUserPrefs.prototype) as SNUserPrefs
  Object.defineProperties(preferences, {
    uuid: { value: 'personal-prefs' },
    deleted: { value: false },
    shared_vault_uuid: { value: undefined },
    key_system_identifier: { value: undefined },
    getPref: { value: () => stored },
  })
  const note = { uuid: 'shared-note', shared_vault_uuid: 'shared-vault', trashed: false }
  const setPref = jest.fn((_key, value) => {
    stored = value
  })
  const changeItem = jest.fn(async (_item, update) => {
    update({ setPref })
    return preferences
  })
  const application = {
    sessions: { getUser: () => user, isCurrentSessionReadOnly: () => false },
    items: { getItems: () => [preferences], findItem: () => note },
    isAuthorizedToRenderItem: () => true,
    mutator: { changeItem },
    sync: { isDatabaseLoaded: () => true, sync: jest.fn(async () => undefined) },
  } as never
  return {
    application,
    preferences,
    changeItem,
    setPref,
    setStored: (value: unknown) => {
      stored = value
    },
    switchAccount: () => {
      user = { uuid: 'user-b' }
    },
  }
}

describe('personal encrypted comment storage', () => {
  it('writes only the personal preferences item for a shared note and retains concurrent local additions', async () => {
    const f = fixture()
    await Promise.all([
      mutatePrivateNoteComments(f.application, 'shared-note', (comments) => [...comments, comment('one')]),
      mutatePrivateNoteComments(f.application, 'shared-note', (comments) => [...comments, comment('two')]),
    ])
    expect(f.changeItem.mock.calls.every(([item]) => item === f.preferences)).toBe(true)
    expect(readPrivateNoteComments(f.application, 'shared-note').map((value) => value.id)).toEqual([
      'user-a:one',
      'user-a:two',
    ])
    expect(f.setPref).toHaveBeenCalledWith('privateNoteComments', expect.objectContaining({ ownerUuid: 'user-a' }))
  })

  it('rejects an account change before a delayed mutation callback and never writes private text to the replacement account', async () => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.changeItem.mockImplementationOnce(async (_item, update) => {
      await gate
      update({ setPref: f.setPref })
      return f.preferences
    })
    const work = mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])
    await Promise.resolve()
    await Promise.resolve()
    f.switchAccount()
    release()
    await expect(work).rejects.toThrow('account changed')
    expect(f.setPref).not.toHaveBeenCalled()
  })

  it('never displays another account payload or accepts malformed/over-limit records', () => {
    const f = fixture()
    f.setStored({ version: 1, ownerUuid: 'user-b', notes: { 'shared-note': [comment('one')] } })
    expect(readPrivateNoteComments(f.application, 'shared-note')).toEqual([])
    expect(normalizePrivateComments({ version: 2, ownerUuid: 'user-a', notes: {} }, 'user-a')).toBeUndefined()
    expect(
      normalizePrivateComments(
        {
          version: 1,
          ownerUuid: 'user-a',
          notes: { note: [{ ...comment('one'), text: 'x'.repeat(MAX_PRIVATE_COMMENT_BYTES) }] },
        },
        'user-a',
      ),
    ).toBeUndefined()
  })

  it('preserves unreadable future metadata and gives actionable limit failures', async () => {
    const f = fixture()
    f.setStored({ version: 2, ownerUuid: 'user-a', notes: {} })
    await expect(mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])).rejects.toThrow(
      'Export',
    )
    expect(f.setPref).not.toHaveBeenCalled()
    f.setStored(undefined)
    await expect(
      mutatePrivateNoteComments(f.application, 'shared-note', () =>
        Array.from({ length: 257 }, (_, i) => comment(`id-${i}`)),
      ),
    ).rejects.toThrow('storage is full')
    expect(f.setPref).not.toHaveBeenCalled()
  })
})
