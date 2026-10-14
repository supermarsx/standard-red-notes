export type AutoVaultRule = { kind: 'tag' | 'folder'; sourceUuid: string; vaultUuid: string }
export type RuleCollection = { uuid: string; parentId?: string; noteReferences: { uuid: string }[] }

export function normalizeAutoVaultRules(value: unknown): AutoVaultRule[] {
  if (!Array.isArray(value) || value.length > 256) {
    return []
  }
  const rules = new Map<string, AutoVaultRule>()
  for (const entry of value) {
    if (
      !entry ||
      (entry.kind !== 'tag' && entry.kind !== 'folder') ||
      typeof entry.sourceUuid !== 'string' ||
      typeof entry.vaultUuid !== 'string' ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(entry.sourceUuid) ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(entry.vaultUuid)
    ) {
      continue
    }
    rules.set(`${entry.kind}:${entry.sourceUuid}`, {
      kind: entry.kind,
      sourceUuid: entry.sourceUuid,
      vaultUuid: entry.vaultUuid,
    })
  }
  return [...rules.values()]
}

export function matchAutoVaultRules(
  noteUuid: string,
  rules: AutoVaultRule[],
  tags: RuleCollection[],
  folders: RuleCollection[],
): AutoVaultRule[] {
  const ancestors = (collections: RuleCollection[]) => {
    const byId = new Map(collections.map((item) => [item.uuid, item]))
    const matches = new Set<string>()
    for (const collection of collections) {
      if (!collection.noteReferences.some((reference) => reference.uuid === noteUuid)) {
        continue
      }
      let current: RuleCollection | undefined = collection
      const visited = new Set<string>()
      while (current && !visited.has(current.uuid) && visited.size < 256) {
        visited.add(current.uuid)
        matches.add(current.uuid)
        current = current.parentId ? byId.get(current.parentId) : undefined
      }
    }
    return matches
  }
  const tagIds = ancestors(tags)
  const folderIds = ancestors(folders)
  return rules.filter((rule) => (rule.kind === 'tag' ? tagIds : folderIds).has(rule.sourceUuid))
}

export function autoVaultDestination(matches: AutoVaultRule[]): { vaultUuid?: string; conflict: boolean } {
  const targets = new Set(matches.map((rule) => rule.vaultUuid))
  return { vaultUuid: targets.size === 1 ? [...targets][0] : undefined, conflict: targets.size > 1 }
}
