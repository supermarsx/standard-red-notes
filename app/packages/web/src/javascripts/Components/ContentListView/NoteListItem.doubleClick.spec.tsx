/** @jest-environment jsdom */

/**
 * Render proof that the notes-list row's DOUBLE-CLICK gesture is actually wired.
 *
 * `ItemListController.openListItemInNewTabFromDoubleClick` is covered by its own
 * spec, but a handler that is never attached to the row — or a first click that
 * fails to record the tab it is about to displace — would leave that logic
 * unreachable while every other gate stayed green. So this mounts the real row
 * (react-dom/client + act; the repo has no @testing-library) and dispatches the
 * real click / click / dblclick sequence a browser produces, asserting on what
 * the row hands the controller.
 */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ContentType, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'

const noop = () => undefined

const stub = (testId: string) => ({
  __esModule: true,
  default: () => createElement('div', { 'data-testid': testId }),
})

jest.mock('@/Components/Icon/Icon', () => stub('icon'))
jest.mock('./ListItemConflictIndicator', () => stub('conflict-indicator'))
jest.mock('./ListItemFlagIcons', () => stub('flag-icons'))
jest.mock('./ListItemTags', () => stub('tags'))
jest.mock('./ListItemMetadata', () => stub('metadata'))
jest.mock('./ListItemNotePreviewText', () => stub('preview'))
jest.mock('./ListItemVaultInfo', () => stub('vault-info'))
jest.mock('../Checkbox/CheckIndicator', () => stub('check-indicator'))
jest.mock('./ListItemTitle', () => ({
  __esModule: true,
  ListItemTitle: () => createElement('div', { 'data-testid': 'title' }),
}))
jest.mock('@/Hooks/useContextMenuEvent', () => ({
  __esModule: true,
  useContextMenuEvent: () => undefined,
}))
jest.mock('@/Hooks/useItem', () => ({
  __esModule: true,
  default: () => undefined,
}))

import NoteListItem from './NoteListItem'
import { DisplayableListItemProps } from './Types/DisplayableListItemProps'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const note = (uuid: string): SNNote =>
  ({ uuid, title: uuid, text: '', content_type: ContentType.TYPES.Note }) as unknown as SNNote

type Displaced = { uuid: string; index: number } | undefined

const makeApplication = (openTabs: { uuid: string }[], activeIndex: number) => {
  const controllers = openTabs.map((item, index) => ({ runtimeId: `rt-${index}`, item }))
  const doubleClickCalls: { uuid: string; displaced: Displaced }[] = []
  const openSingleSelectedItem = jest.fn().mockResolvedValue(undefined)

  const application = {
    componentManager: { editorForNote: () => undefined },
    items: { itemsReferencingItem: () => [] },
    itemControllerGroup: {
      itemControllers: controllers,
      activeItemViewController: controllers[activeIndex],
    },
    itemListController: {
      isMultipleSelectionMode: false,
      isCustomSortMode: false,
      recentlyCreatedNoteUuid: undefined,
      enableMultipleSelectionMode: noop,
      replaceSelection: noop,
      reorderNoteByDrag: noop,
      openSingleSelectedItem,
      openListItemInNewTabFromDoubleClick: async (uuid: string, displaced: Displaced) => {
        doubleClickCalls.push({ uuid, displaced })
      },
    },
  } as unknown as WebApplication

  return { application, doubleClickCalls, openSingleSelectedItem }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => false,
    }),
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const mountRow = (application: WebApplication, item: SNNote, selected: boolean, onSelect: jest.Mock) => {
  act(() => {
    root.render(
      createElement(NoteListItem, {
        application,
        notesController: { setContextMenuClickLocation: noop, setContextMenuOpen: noop },
        onSelect,
        item,
        selected,
        tags: [],
      } as unknown as DisplayableListItemProps<SNNote>),
    )
  })
  return container.querySelector(`[id="${item.uuid}"]`) as HTMLElement
}

/** The event sequence a browser emits for a double click on one element. */
const doubleClick = (row: HTMLElement) => {
  act(() => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
  })
}

describe('double-clicking a notes-list row', () => {
  it('asks for a new tab, naming the tab the first click displaced and its index', () => {
    const { application, doubleClickCalls } = makeApplication([{ uuid: 'open-x' }, { uuid: 'open-y' }], 1)
    const row = mountRow(application, note('note-b'), false, jest.fn().mockResolvedValue({ didSelect: true }))

    doubleClick(row)

    expect(doubleClickCalls).toEqual([{ uuid: 'note-b', displaced: { uuid: 'open-y', index: 1 } }])
  })

  it('reports no displaced tab when the editor had nothing open', () => {
    const { application, doubleClickCalls } = makeApplication([], 0)
    const row = mountRow(application, note('note-b'), false, jest.fn().mockResolvedValue({ didSelect: true }))

    doubleClick(row)

    expect(doubleClickCalls).toEqual([{ uuid: 'note-b', displaced: undefined }])
  })

  it('leaves the ordinary single click alone', () => {
    const { application, doubleClickCalls } = makeApplication([{ uuid: 'open-x' }], 0)
    const onSelect = jest.fn().mockResolvedValue({ didSelect: true })
    const row = mountRow(application, note('note-b'), false, onSelect)

    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(doubleClickCalls).toEqual([])
  })

  it('ignores the gesture in multiple-selection mode, where a click is a checkbox', () => {
    const { application, doubleClickCalls } = makeApplication([{ uuid: 'open-x' }], 0)
    ;(application.itemListController as unknown as { isMultipleSelectionMode: boolean }).isMultipleSelectionMode = true
    const row = mountRow(application, note('note-b'), false, jest.fn().mockResolvedValue({ didSelect: true }))

    doubleClick(row)

    expect(doubleClickCalls).toEqual([])
  })
})
