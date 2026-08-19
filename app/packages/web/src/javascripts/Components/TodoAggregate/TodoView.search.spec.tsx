/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { FeatureStatus, NoteType, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import TodoView from './TodoView'
import { CHECKLIST_TODO_ID_STATE_KEY } from '../SuperEditor/Lexical/Nodes/ChecklistItemNode'

/**
 * Render-path coverage for instant search in the Todos general view. A green
 * type-check and green filter tests do not prove the box reaches the DOM or
 * that typing in it re-renders the list, so the real view is driven here.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const superChecklistJson = (items: { text: string; todoId: string }[]): string =>
  JSON.stringify({
    root: {
      type: 'root',
      children: [
        {
          type: 'list',
          listType: 'check',
          children: items.map((item) => ({
            type: 'listitem',
            checked: false,
            $: { [CHECKLIST_TODO_ID_STATE_KEY]: item.todoId },
            children: [{ type: 'text', text: item.text }],
          })),
        },
      ],
    },
  })

const makeNote = (uuid: string, title: string, text: string): SNNote =>
  ({ uuid, title, text, trashed: false, locked: false, noteType: NoteType.Super, payload: {} }) as unknown as SNNote

const notes = [
  makeNote(
    'groceries',
    'Groceries',
    superChecklistJson([
      { text: 'Buy milk', todoId: 'todo-milk' },
      { text: 'Call the plumber', todoId: 'todo-plumber' },
    ]),
  ),
  makeNote('roadmap', 'Product roadmap', superChecklistJson([{ text: 'Ship the beta', todoId: 'todo-beta' }])),
]

let container: HTMLElement
let root: Root
let application: WebApplication

const searchInput = () =>
  container.querySelector<HTMLInputElement>('input[aria-label="Search todos"]') as HTMLInputElement

const type = (value: string) => {
  const input = searchInput()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The rendered todo rows, read from each row's selection checkbox label. */
const visibleTodoText = () =>
  Array.from(container.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]')).map((box) =>
    (box.getAttribute('aria-label') ?? '').replace(/^Select /, ''),
  )

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  application = {
    items: {
      getItems: () => notes,
      streamItems: () => () => undefined,
      findItem: (uuid: string) => notes.find((note) => note.uuid === uuid),
    },
    addEventObserver: () => () => undefined,
    isAuthorizedToRenderItem: () => true,
    vaults: { getItemVault: () => undefined },
    sessions: { isCurrentSessionReadOnly: () => false },
    vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
    features: { getFeatureStatus: () => FeatureStatus.Entitled },
    paneController: { closeViewTab: () => undefined, setActiveViewTab: () => undefined, presentPane: () => undefined },
    itemControllerGroup: { itemControllers: [] },
  } as unknown as WebApplication

  act(() => {
    root.render(createElement(TodoView, { application, id: 'todos' }))
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Todos general view instant search', () => {
  it('renders a search box and lists every todo before anything is typed', () => {
    expect(searchInput()).not.toBeNull()
    expect(searchInput().value).toBe('')
    expect(visibleTodoText()).toEqual(['Buy milk', 'Call the plumber', 'Ship the beta'])
    // No Clear button until there is something to clear.
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Clear')).toBe(
      false,
    )
  })

  it('filters the list on every keystroke, with no commit step', () => {
    // "b" is in every row ("plum-b-er", "the b-eta"); each further character
    // narrows the list immediately, with no submit or blur in between.
    type('b')
    expect(visibleTodoText()).toEqual(['Buy milk', 'Call the plumber', 'Ship the beta'])
    type('bu')
    expect(visibleTodoText()).toEqual(['Buy milk'])
    type('buy m')
    expect(visibleTodoText()).toEqual(['Buy milk'])
    type('buy z')
    expect(visibleTodoText()).toEqual([])
  })

  it('matches the source note title as well as the todo text', () => {
    type('roadmap')
    expect(visibleTodoText()).toEqual(['Ship the beta'])
  })

  it('survives a rapid burst of keystrokes and settles on the final query', () => {
    for (const value of ['s', 'sh', 'shi', 'ship', 'ship ', 'ship t', 'ship th', 'ship the']) {
      type(value)
    }
    expect(searchInput().value).toBe('ship the')
    expect(visibleTodoText()).toEqual(['Ship the beta'])
  })

  it('shows a no-match empty state rather than the never-had-todos message', () => {
    type('nothing matches this')
    expect(container.textContent).toContain('No todos match your search.')
    expect(container.textContent).not.toContain('No todos yet.')
    expect(visibleTodoText()).toEqual([])
  })

  it('restores the full list through the Clear button', () => {
    type('milk')
    expect(visibleTodoText()).toEqual(['Buy milk'])
    const clear = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Clear',
    ) as HTMLButtonElement
    act(() => clear.click())
    expect(searchInput().value).toBe('')
    expect(visibleTodoText()).toEqual(['Buy milk', 'Call the plumber', 'Ship the beta'])
  })
})
