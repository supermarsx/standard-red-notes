import { applyTodoPatch } from './todoActions'
import { registerChecklistMutationBridge } from '../SuperEditor/Checklist/ChecklistMutationBridge'

const target = { todoId: 'todo-a', locator: '0.0', text: 'A', checked: false }

describe('Todo aggregate mutation routing', () => {
  it('uses only the exact active editor lease', async () => {
    const application = {} as never
    const handler = jest.fn(() => ({ status: 'updated' as const, todoId: 'todo-a', changed: true }))
    const dispose = registerChecklistMutationBridge(application, 'note-a', 'owner-a', handler)

    await expect(applyTodoPatch(application, 'note-a', 'owner-a', target, { checked: true })).resolves.toEqual({
      ok: true,
      todoId: 'todo-a',
      changed: true,
    })
    await expect(applyTodoPatch(application, 'note-a', 'owner-b', target, { checked: true })).resolves.toMatchObject({
      ok: false,
    })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ target, patch: { checked: true } })
    dispose()
  })

  it('never rewrites inactive note JSON outside its Lexical/Yjs owner', async () => {
    const application = {
      mutator: { changeItem: jest.fn() },
      items: { findItem: jest.fn() },
    }

    await expect(
      applyTodoPatch(application as never, 'note-a', 'missing-owner', target, { checked: true }),
    ).resolves.toEqual({
      ok: false,
      reason: 'The source note editor is not ready for this action.',
      retryAcquire: true,
    })
    expect(application.mutator.changeItem).not.toHaveBeenCalled()
    expect(application.items.findItem).not.toHaveBeenCalled()
  })

  it('does not fall back and preserves an owner-retention failure signal', async () => {
    const application = { mutator: { changeItem: jest.fn() } }
    const dispose = registerChecklistMutationBridge(application, 'note-a', 'owner-a', () => ({
      status: 'rejected',
      reason: 'The checklist update could not be saved safely.',
      retainOwner: true,
    }))

    await expect(applyTodoPatch(application as never, 'note-a', 'owner-a', target, { checked: true })).resolves.toEqual(
      {
        ok: false,
        reason: 'The checklist update could not be saved safely.',
        retainOwner: true,
      },
    )
    expect(application.mutator.changeItem).not.toHaveBeenCalled()
    dispose()
  })

  it('converts a throwing active owner into a surfaced action failure', async () => {
    const application = {}
    const dispose = registerChecklistMutationBridge(application, 'note-a', 'owner-a', () => {
      throw new Error('editor failed')
    })
    await expect(applyTodoPatch(application as never, 'note-a', 'owner-a', target, { checked: true })).resolves.toEqual(
      {
        ok: false,
        reason: 'The todo could not be updated.',
      },
    )
    dispose()
  })
})
