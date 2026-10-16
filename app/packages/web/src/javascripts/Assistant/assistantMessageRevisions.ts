/**
 * UI message updates are immutable at the outer message boundary. Compare that
 * identity rather than serializing every historic attachment and undo snapshot
 * on each streaming paint. New objects are conservatively dirty even if equal.
 */
export function changedAssistantMessageIds<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
): Set<string> {
  const previousById = new Map(previous.map((message) => [message.id, message]))
  const changed = new Set<string>()
  for (const message of next) {
    if (previousById.get(message.id) !== message) {
      changed.add(message.id)
    }
    previousById.delete(message.id)
  }
  for (const id of previousById.keys()) {
    changed.add(id)
  }
  return changed
}
