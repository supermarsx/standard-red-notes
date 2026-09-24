import { conflictWarningForNote, describeConflictWarning } from './useConflictWarnings'

/**
 * The conflict toast used to be suppressed entirely when the original note was gone,
 * which silenced the one case where the user most needs telling: their note vanished
 * and the only surviving copy of their work is the conflicted duplicate.
 */
describe('describeConflictWarning', () => {
  it('tells the user their work was recovered when the original is gone', () => {
    const { title, message } = describeConflictWarning(false)

    expect(title).toEqual('Note recovered from a conflict')
    expect(message).toContain('no longer exists')
    expect(message).toContain('nothing was lost')
    // It must not claim a server version was kept — that note does not exist.
    expect(message).not.toContain('server')
  })

  it('keeps the ordinary two-copies wording when the original survives', () => {
    const { title, message } = describeConflictWarning(true)

    expect(title).toEqual('Sync conflict')
    expect(message).toContain('both kept as separate copies')
  })

  it('points the user to the same place in both cases', () => {
    expect(describeConflictWarning(true).message).toContain('Preferences → Sync')
    expect(describeConflictWarning(false).message).toContain('Preferences → Sync')
  })
})

describe('conflictWarningForNote', () => {
  const copy = { uuid: 'copy-uuid', conflictOf: 'original-uuid' }

  it('WARNS when the original no longer exists — the case that used to be skipped', () => {
    const warning = conflictWarningForNote(copy, false, false)

    expect(warning).toBeDefined()
    expect(warning?.title).toEqual('Note recovered from a conflict')
  })

  it('warns for an ordinary conflict whose original survives', () => {
    const warning = conflictWarningForNote(copy, true, false)

    expect(warning).toBeDefined()
    expect(warning?.title).toEqual('Sync conflict')
  })

  it('stays silent for a note that is not a conflicted copy', () => {
    expect(conflictWarningForNote({ uuid: 'plain-uuid' }, false, false)).toBeUndefined()
  })

  it('stays silent for a copy it has already warned about, missing original included', () => {
    expect(conflictWarningForNote(copy, true, true)).toBeUndefined()
    expect(conflictWarningForNote(copy, false, true)).toBeUndefined()
  })
})
