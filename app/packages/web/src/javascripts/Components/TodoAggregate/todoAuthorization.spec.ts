import { FeatureStatus, NoteType, SNNote } from '@standardnotes/snjs'
import { canDisplayTodoNote, canMutateSuperChecklistNote, collectAuthorizedTodoGroups } from './todoAuthorization'

const checklistText = JSON.stringify({
  root: {
    type: 'root',
    children: [
      {
        type: 'list',
        listType: 'check',
        children: [{ type: 'listitem', checked: false, children: [{ type: 'text', text: 'Private task' }] }],
      },
    ],
  },
})

const note = (overrides: Partial<SNNote> = {}): SNNote =>
  ({
    uuid: 'private-note',
    title: 'Private title',
    noteType: NoteType.Super,
    text: checklistText,
    trashed: false,
    locked: false,
    payload: { content: {} },
    ...overrides,
  }) as SNNote

const application = (options: { authorized?: boolean; sessionReadonly?: boolean; vaultReadonly?: boolean } = {}) => {
  const vault = options.vaultReadonly ? { isSharedVaultListing: () => true } : undefined
  return {
    isAuthorizedToRenderItem: () => options.authorized ?? true,
    sessions: { isCurrentSessionReadOnly: () => options.sessionReadonly ?? false },
    vaults: { getItemVault: () => vault },
    vaultUsers: { isCurrentUserReadonlyVaultMember: () => options.vaultReadonly ?? false },
    features: { getFeatureStatus: () => FeatureStatus.Entitled },
  } as never
}

describe('Todo aggregate authorization', () => {
  it('filters unauthorized, locked, and lite notes before their title or plaintext can enter groups', () => {
    const unauthorized = note()
    const locked = note({ uuid: 'locked-note', locked: true })
    const lite = note({ uuid: 'lite-note', payload: { content: { __lazyLite: true } } as never })

    const groups = collectAuthorizedTodoGroups(application({ authorized: false }), [unauthorized, locked, lite])
    expect(groups).toEqual([])
    expect(JSON.stringify(groups)).not.toContain('Private title')
    expect(JSON.stringify(groups)).not.toContain('Private task')
    expect(canDisplayTodoNote(application(), locked)).toBe(false)
    expect(canDisplayTodoNote(application(), lite)).toBe(false)
  })

  it('refuses writes for read-only sessions and read-only shared-vault members', () => {
    expect(canMutateSuperChecklistNote(application({ sessionReadonly: true }), note())).toBe(false)
    expect(canMutateSuperChecklistNote(application({ vaultReadonly: true }), note())).toBe(false)
    expect(canMutateSuperChecklistNote(application(), note())).toBe(true)
  })
})
