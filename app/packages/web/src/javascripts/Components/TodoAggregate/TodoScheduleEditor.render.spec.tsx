/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { TodoScheduleEditor } from './TodoView'
import { checklistDueAtToLocalInput } from '../SuperEditor/Checklist/checklistDueDate'
import type { SuperChecklistTodoPatch, SuperChecklistTodoTarget } from './superChecklistDocument'
import type { TodoItem } from './allTodos'

/**
 * Render-path coverage for a schedule entered as a DATE with no time. A green
 * type-check and green parser tests do not prove the form can express a missing
 * time at all, so the editor is driven here through its real DOM.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item: TodoItem = { id: 'todo-milk', todoId: 'todo-milk', locator: '0.0', text: 'Buy milk', checked: false }
const target: SuperChecklistTodoTarget = { todoId: 'todo-milk', locator: '0.0', text: 'Buy milk', checked: false }

const mountEditor = async (onSave: (patch: SuperChecklistTodoPatch) => Promise<boolean>) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      createElement(TodoScheduleEditor, {
        item,
        target,
        busy: false,
        onOpen: () => Promise.resolve(target),
        onSave: (patch: SuperChecklistTodoPatch) => onSave(patch),
      }),
    )
  })
  // Opening the panel awaits the durable target, so the fields only exist once
  // the microtask queue has drained.
  const trigger = container.querySelector('button') as HTMLButtonElement
  await act(async () => {
    trigger.click()
  })
  return {
    container,
    date: container.querySelector<HTMLInputElement>('input[type="date"]') as HTMLInputElement,
    time: container.querySelector<HTMLInputElement>('input[type="time"]') as HTMLInputElement,
    save: Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    ) as HTMLButtonElement,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

const setValue = (input: HTMLInputElement, value: string) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Todo schedule editor date without a time', () => {
  it('exposes a separate, optional time field next to the due date', async () => {
    const editor = await mountEditor(() => Promise.resolve(true))
    expect(editor.date).not.toBeNull()
    expect(editor.time).not.toBeNull()
    expect(editor.time.value).toBe('')
    expect(editor.container.textContent).toContain('Time (optional)')
    editor.unmount()
  })

  it('saves a date with a blank time as local 00:00', async () => {
    const saved: SuperChecklistTodoPatch[] = []
    const editor = await mountEditor((patch) => {
      saved.push(patch)
      return Promise.resolve(true)
    })

    setValue(editor.date, '2026-08-20')
    await act(async () => {
      editor.save.click()
    })

    expect(saved).toHaveLength(1)
    expect(checklistDueAtToLocalInput(saved[0].dueAt as string)).toBe('2026-08-20T00:00')
    editor.unmount()
  })

  it('leaves a supplied time untouched', async () => {
    const saved: SuperChecklistTodoPatch[] = []
    const editor = await mountEditor((patch) => {
      saved.push(patch)
      return Promise.resolve(true)
    })

    setValue(editor.date, '2026-08-20')
    setValue(editor.time, '17:45')
    await act(async () => {
      editor.save.click()
    })

    expect(checklistDueAtToLocalInput(saved[0].dueAt as string)).toBe('2026-08-20T17:45')
    editor.unmount()
  })

  it('refuses a time with no date and says the time is optional', async () => {
    const saved: SuperChecklistTodoPatch[] = []
    const editor = await mountEditor((patch) => {
      saved.push(patch)
      return Promise.resolve(true)
    })

    setValue(editor.time, '09:30')
    await act(async () => {
      editor.save.click()
    })

    expect(saved).toHaveLength(0)
    expect(editor.container.textContent).toContain('Choose a valid due date. Leave the time blank for 00:00.')
    editor.unmount()
  })
})
