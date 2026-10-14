import { autoVaultDestination, matchAutoVaultRules, normalizeAutoVaultRules } from './autoVaultRules'

it('inherits topic and folder rules without choosing between conflicting destinations', () => {
  const rules = [
    { kind: 'tag' as const, sourceUuid: 'parent', vaultUuid: 'vault-a' },
    { kind: 'folder' as const, sourceUuid: 'folder', vaultUuid: 'vault-b' },
  ]
  const tags = [
    { uuid: 'parent', noteReferences: [] },
    { uuid: 'child', parentId: 'parent', noteReferences: [{ uuid: 'note' }] },
  ]
  const folders = [
    { uuid: 'folder', noteReferences: [] },
    { uuid: 'subfolder', parentId: 'folder', noteReferences: [{ uuid: 'note' }] },
  ]
  expect(autoVaultDestination(matchAutoVaultRules('note', rules, tags, folders))).toEqual({
    conflict: true,
    vaultUuid: undefined,
  })
  expect(autoVaultDestination(matchAutoVaultRules('note', [rules[0]], tags, folders))).toEqual({
    conflict: false,
    vaultUuid: 'vault-a',
  })
})

it('bounds untrusted preferences and handles hierarchy cycles', () => {
  expect(
    normalizeAutoVaultRules([
      { kind: 'tag', sourceUuid: 'topic', vaultUuid: 'vault' },
      { kind: 'tag', sourceUuid: 'topic', vaultUuid: 'vault-new' },
      { kind: 'unknown', sourceUuid: 'bad', vaultUuid: 'bad' },
    ]),
  ).toEqual([{ kind: 'tag', sourceUuid: 'topic', vaultUuid: 'vault-new' }])
  expect(normalizeAutoVaultRules(Array(257).fill({ kind: 'tag', sourceUuid: 'topic', vaultUuid: 'vault' }))).toEqual([])
  expect(
    matchAutoVaultRules(
      'note',
      [{ kind: 'folder', sourceUuid: 'b', vaultUuid: 'vault' }],
      [],
      [
        { uuid: 'a', parentId: 'b', noteReferences: [{ uuid: 'note' }] },
        { uuid: 'b', parentId: 'a', noteReferences: [] },
      ],
    ),
  ).toHaveLength(1)
})
