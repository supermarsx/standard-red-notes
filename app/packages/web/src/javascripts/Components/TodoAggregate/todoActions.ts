import type { WebApplication } from '@/Application/WebApplication'
import { createChecklistTodoId } from '../SuperEditor/Lexical/Nodes/ChecklistItemNode'
import { mutateThroughActiveChecklistBridge } from '../SuperEditor/Checklist/ChecklistMutationBridge'
import type { SuperChecklistTodoPatch, SuperChecklistTodoTarget } from './superChecklistDocument'

export type TodoActionResult =
  | { ok: true; todoId?: string; changed: boolean }
  | { ok: false; reason: string; retainOwner?: boolean; retryAcquire?: boolean }

/**
 * Apply only through the exact mounted Lexical/Yjs owner. Rewriting persisted
 * note JSON while another device owns a live Yjs document can create a conflict
 * copy and lose realtime authority, so inactive notes deliberately fail closed.
 */
export async function applyTodoPatch(
  application: WebApplication,
  noteUuid: string,
  ownerLeaseId: string,
  target: SuperChecklistTodoTarget,
  patch: SuperChecklistTodoPatch,
): Promise<TodoActionResult> {
  const effectivePatch =
    target.todoId || patch.ensureTodoId ? patch : { ...patch, ensureTodoId: createChecklistTodoId() }
  let activePromise: ReturnType<typeof mutateThroughActiveChecklistBridge>
  try {
    activePromise = mutateThroughActiveChecklistBridge(application, noteUuid, ownerLeaseId, {
      target,
      patch: effectivePatch,
    })
  } catch {
    return { ok: false, reason: 'The todo could not be updated.' }
  }
  if (!activePromise) {
    return { ok: false, reason: 'The source note editor is not ready for this action.', retryAcquire: true }
  }
  let active
  try {
    active = await activePromise
  } catch {
    return { ok: false, reason: 'The todo could not be updated.' }
  }
  return active.status === 'updated'
    ? { ok: true, todoId: active.todoId, changed: active.changed ?? true }
    : {
        ok: false,
        reason: active.reason,
        ...(active.retainOwner ? { retainOwner: true } : {}),
        ...(active.retryAcquire ? { retryAcquire: true } : {}),
      }
}

export async function ensureTodoIdentity(
  application: WebApplication,
  noteUuid: string,
  ownerLeaseId: string,
  target: SuperChecklistTodoTarget,
): Promise<TodoActionResult> {
  if (target.todoId) {
    return { ok: true, todoId: target.todoId, changed: false }
  }
  const todoId = createChecklistTodoId()
  return applyTodoPatch(application, noteUuid, ownerLeaseId, target, { ensureTodoId: todoId })
}
