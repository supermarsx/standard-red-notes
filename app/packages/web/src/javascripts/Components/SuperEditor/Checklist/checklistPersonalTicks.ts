import { ListItemNode } from '@lexical/list'
import { $getState, $setState, createState } from 'lexical'

const PREFIX = 'srnChecklistTick_'
const completionMode = createState('srnChecklistPerPerson', { parse: (value) => value === true, resetOnCopyNode: true })
const validUserId = (value: string) => /^[A-Za-z0-9-]{1,96}$/.test(value)
const parseTick = (value: unknown): boolean => value === true
const states = new Map<string, ReturnType<typeof createTickState>>()
const createTickState = (userId: string) =>
  createState(`${PREFIX}${userId}`, { parse: parseTick, resetOnCopyNode: true })

function tickState(userId: string) {
  if (!validUserId(userId)) {
    throw new Error('A signed-in account is required to tick a checklist item.')
  }
  let state = states.get(userId)
  if (!state) {
    state = createTickState(userId)
    states.set(userId, state)
  }
  return state
}

/** One NodeState/Yjs map key per account: concurrent people never replace a shared array. */
export function $setChecklistPersonalTick(item: ListItemNode, userId: string, checked: boolean): void {
  $setState(item, tickState(userId), checked)
}

export function $isChecklistPerPerson(item: ListItemNode): boolean {
  return $getState(item, completionMode)
}

export function $setChecklistPerPerson(item: ListItemNode, enabled: boolean): void {
  $setState(item, completionMode, enabled)
  if (enabled && item.getChecked()) {
    item.setChecked(false)
  }
}

export function $getChecklistCheckedForUser(item: ListItemNode, userId?: string): boolean {
  return $isChecklistPerPerson(item)
    ? Boolean(userId && $hasChecklistPersonalTick(item, userId))
    : item.getChecked() === true
}

export function $hasChecklistPersonalTick(item: ListItemNode, userId: string): boolean {
  return validUserId(userId) && $getState(item, tickState(userId))
}

/** Read unknown keys too, including marks from peers not encountered in this browser yet. */
export function $getChecklistPersonalTicks(item: ListItemNode): string[] {
  const serialized = item.exportJSON() as { $?: Record<string, unknown> }
  return Object.entries(serialized.$ ?? {})
    .filter(([key, value]) => key.startsWith(PREFIX) && validUserId(key.slice(PREFIX.length)) && value === true)
    .map(([key]) => key.slice(PREFIX.length))
    .sort()
}
