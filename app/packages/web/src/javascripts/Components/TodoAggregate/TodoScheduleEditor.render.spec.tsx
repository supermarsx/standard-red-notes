/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WebApplication } from '@/Application/WebApplication'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import { TodoScheduleEditor } from './TodoView'
import { checklistDueAtToLocalInput } from '../SuperEditor/Checklist/checklistDueDate'
import type { SuperChecklistTodoPatch, SuperChecklistTodoTarget } from './superChecklistDocument'
import type { TodoItem } from './allTodos'

/**
 * Render-path coverage for a schedule entered as a DATE with no time. A green
 * type-check and green parser tests do not prove the form can express a missing
 * time at all, so the editor is driven here through its real DOM.
 *
 * The form lives in a Popover (the todo row is a table cell that clips its
 * overflow), so its fields render into a portal on document.body rather than
 * inside the mounted container — the queries below reflect that.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const stubApplication = () =>
  ({
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
  }) as unknown as WebApplication

/** jsdom ships neither ResizeObserver nor Element.animate, which the real Popover uses. */
class ImmediateResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as never)
  }
  unobserve() {}
  disconnect() {}
}

let originalResizeObserver: typeof ResizeObserver
let originalAnimate: typeof HTMLElement.prototype.animate

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver
  originalAnimate = HTMLElement.prototype.animate
  window.matchMedia = ((query: string) => ({
    matches: query === '(min-width: 768px)',
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = ImmediateResizeObserver as unknown as typeof ResizeObserver
  HTMLElement.prototype.animate = (() =>
    ({
      currentTime: 0,
      finished: Promise.resolve(),
      cancel: () => undefined,
    }) as unknown as Animation) as typeof HTMLElement.prototype.animate
})

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver
  HTMLElement.prototype.animate = originalAnimate
})

const item: TodoItem = {
  id: 'todo-milk',
  todoId: 'todo-milk',
  locator: '0.0',
  text: 'Buy milk',
  checked: false,
  depth: 0,
}
const target: SuperChecklistTodoTarget = { todoId: 'todo-milk', locator: '0.0', text: 'Buy milk', checked: false }

const mountEditor = async (onSave: (patch: SuperChecklistTodoPatch) => Promise<boolean>) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const application = stubApplication()
  act(() => {
    root.render(
      createElement(ApplicationProvider, {
        application,
        children: createElement(AndroidBackHandlerProvider, {
          application,
          children: createElement(TodoScheduleEditor, {
            item,
            target,
            busy: false,
            onOpen: () => Promise.resolve(target),
            onSave: (patch: SuperChecklistTodoPatch) => onSave(patch),
          }),
        }),
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
    date: document.querySelector<HTMLInputElement>('input[type="date"]') as HTMLInputElement,
    time: document.querySelector<HTMLInputElement>('input[type="time"]') as HTMLInputElement,
    save: Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    ) as HTMLButtonElement,
    panelText: () => document.body.textContent ?? '',
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
    expect(editor.panelText()).toContain('Time (optional)')
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
    expect(editor.panelText()).toContain('Choose a valid due date. Leave the time blank for 00:00.')
    editor.unmount()
  })
})
