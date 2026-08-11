import { checklistDueAtToLocalInput } from '../SuperEditor/Checklist/checklistDueDate'

export type TodoDueDrafts = ReadonlyMap<string, string>

export function todoDueInputValue(drafts: TodoDueDrafts, key: string, persistedDueAt?: string): string {
  return drafts.get(key) ?? (persistedDueAt ? checklistDueAtToLocalInput(persistedDueAt) : '')
}

export function setTodoDueDraft(drafts: TodoDueDrafts, key: string, value: string): TodoDueDrafts {
  const next = new Map(drafts)
  next.set(key, value)
  return next
}

export function clearTodoDueDraft(drafts: TodoDueDrafts, key: string): TodoDueDrafts {
  if (!drafts.has(key)) {
    return drafts
  }
  const next = new Map(drafts)
  next.delete(key)
  return next
}
