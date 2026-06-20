import {
  canLeaveVault,
  canRemoveMembers,
  deriveVaultRole,
  formatVaultRole,
  groupSharedItemsByType,
  labelForContentType,
  summarizePresence,
} from './sharingSummary'

describe('deriveVaultRole', () => {
  it('treats owner as the highest role even if admin/readonly also set', () => {
    expect(deriveVaultRole({ isOwner: true, isAdmin: true, isReadonly: false })).toBe('owner')
  })

  it('returns admin when admin but not owner', () => {
    expect(deriveVaultRole({ isOwner: false, isAdmin: true, isReadonly: false })).toBe('admin')
  })

  it('returns readonly when only readonly', () => {
    expect(deriveVaultRole({ isOwner: false, isAdmin: false, isReadonly: true })).toBe('readonly')
  })

  it('defaults to member', () => {
    expect(deriveVaultRole({ isOwner: false, isAdmin: false, isReadonly: false })).toBe('member')
  })
})

describe('role-based permissions', () => {
  it('only owner/admin can remove members', () => {
    expect(canRemoveMembers('owner')).toBe(true)
    expect(canRemoveMembers('admin')).toBe(true)
    expect(canRemoveMembers('member')).toBe(false)
    expect(canRemoveMembers('readonly')).toBe(false)
  })

  it('everyone but the owner can leave', () => {
    expect(canLeaveVault('owner')).toBe(false)
    expect(canLeaveVault('admin')).toBe(true)
    expect(canLeaveVault('member')).toBe(true)
    expect(canLeaveVault('readonly')).toBe(true)
  })

  it('formats role labels', () => {
    expect(formatVaultRole('owner')).toBe('Owner')
    expect(formatVaultRole('readonly')).toBe('Read-only')
  })
})

describe('labelForContentType', () => {
  it('maps known content types to friendly labels', () => {
    expect(labelForContentType('Note')).toBe('Notes')
    expect(labelForContentType('Tag')).toBe('Folders & Tags')
    expect(labelForContentType('SN|File')).toBe('Files')
  })

  it('passes unknown types through unchanged', () => {
    expect(labelForContentType('SN|Component')).toBe('SN|Component')
  })
})

describe('groupSharedItemsByType', () => {
  const items = [
    { uuid: 'f1', content_type: 'SN|File', title: 'photo.png' },
    { uuid: 'n2', content_type: 'Note', title: 'Beta' },
    { uuid: 't1', content_type: 'Tag', title: 'Work' },
    { uuid: 'n1', content_type: 'Note', title: 'Alpha' },
  ]

  it('groups by content type with counts', () => {
    const groups = groupSharedItemsByType(items)
    const notes = groups.find((g) => g.contentType === 'Note')
    expect(notes?.count).toBe(2)
    expect(notes?.label).toBe('Notes')
  })

  it('orders groups Notes, then Folders & Tags, then Files', () => {
    const order = groupSharedItemsByType(items).map((g) => g.contentType)
    expect(order).toEqual(['Note', 'Tag', 'SN|File'])
  })

  it('sorts items within a group by title', () => {
    const notes = groupSharedItemsByType(items).find((g) => g.contentType === 'Note')
    expect(notes?.items.map((i) => i.title)).toEqual(['Alpha', 'Beta'])
  })

  it('returns an empty array for no items', () => {
    expect(groupSharedItemsByType([])).toEqual([])
  })
})

describe('summarizePresence', () => {
  it('counts distinct peers and preserves first-seen names', () => {
    const summary = summarizePresence([
      { userUuid: 'u1', name: 'Ada', clientId: 1 },
      { userUuid: 'u2', name: 'Grace', clientId: 2 },
      { userUuid: 'u1', name: 'Ada (other tab)', clientId: 3 },
    ])
    expect(summary.count).toBe(2)
    expect(summary.names).toEqual(['Ada', 'Grace'])
  })

  it('dedupes uuid-less peers by clientId', () => {
    const summary = summarizePresence([
      { name: 'Anon', clientId: 7 },
      { name: 'Anon', clientId: 7 },
      { name: 'Other', clientId: 8 },
    ])
    expect(summary.count).toBe(2)
  })

  it('returns zero for nobody present', () => {
    expect(summarizePresence([])).toEqual({ count: 0, names: [] })
  })
})
