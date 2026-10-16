/** Reconcile an observed encrypted checkpoint without replacing unacknowledged local edits. */
export function reconcileAssistantSharedMessages<T extends { id: string }>(
  incoming: T[],
  local: T[],
  dirtyIds: ReadonlySet<string>,
): T[] {
  const localById = new Map(local.map((message) => [message.id, message]))
  const seen = new Set<string>()
  const merged: T[] = []
  for (const message of incoming) {
    seen.add(message.id)
    const current = localById.get(message.id)
    if (dirtyIds.has(message.id)) {
      if (current) {
        merged.push(current)
      }
    } else {
      merged.push(message)
    }
  }
  for (const message of local) {
    if (!seen.has(message.id) && dirtyIds.has(message.id)) {
      merged.push(message)
    }
  }
  return merged
}

/** Clear only the local revisions contained in this completed checkpoint. */
export function acknowledgeAssistantSharedVersions(
  dirty: Map<string, number>,
  sent: ReadonlyMap<string, number>,
): void {
  for (const [id, version] of sent) {
    if (dirty.get(id) === version) {
      dirty.delete(id)
    }
  }
}
