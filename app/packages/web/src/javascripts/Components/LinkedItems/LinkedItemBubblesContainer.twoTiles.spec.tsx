/** @jest-environment jsdom
 *
 * Standard Red Notes (t112): "Link topics, notes, files" must focus the link input of the
 * note the user is looking at.
 *
 * One LinkedItemBubblesContainer is mounted per OPEN note, not per visible note — from the
 * second open tab onward the tiled editor mounts every NoteView and merely hides the
 * inactive ones. Each registers the same `FOCUS_TAGS_INPUT_COMMAND` handler, and the
 * keyboard service holds a Set and calls every one of them, so the shortcut used to end up
 * focusing the LAST mounted tile's input — a different note, and in single-tile layout a
 * `hidden` one, where focus silently goes nowhere.
 *
 * Both tests mount TWO containers inside two tiles; with one container there is nothing to
 * choose between and the bug cannot appear.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import LinkedItemBubblesContainer from './LinkedItemBubblesContainer'

type MockLinks = {
  notesLinkedToItem: unknown[]
  filesLinkedToItem: unknown[]
  tagsLinkedToItem: unknown[]
  notesLinkingToItem: unknown[]
  filesLinkingToItem: unknown[]
}

const noLinks: MockLinks = {
  notesLinkedToItem: [],
  filesLinkedToItem: [],
  tagsLinkedToItem: [],
  notesLinkingToItem: [],
  filesLinkingToItem: [],
}

/** Stands in for the keyboard service: a Set of handlers, all of which are called. */
const keyboardHandlers = new Set<{ command: string; onKeyDown?: () => void }>()
/** Stands in for the command palette registry: a Map keyed by command id. */
const paletteHandlers = new Map<string, () => void>()

let activeItemUuid: string | undefined

const mockApplication = {
  keyboardService: {
    addCommandHandler: (handler: { command: string; onKeyDown?: () => void }) => {
      keyboardHandlers.add(handler)
      return () => keyboardHandlers.delete(handler)
    },
    keyboardShortcutForCommand: () => ({}) as never,
    triggerCommand: (command: string) => {
      Array.from(keyboardHandlers)
        .reverse()
        .forEach((handler) => {
          if (handler.command === command) {
            handler.onKeyDown?.()
          }
        })
    },
  },
  commands: {
    add: (id: string, _description: string, handler: () => void) => {
      paletteHandlers.set(id, handler)
      return () => paletteHandlers.delete(id)
    },
  },
  itemControllerGroup: {
    get activeItemViewController() {
      return activeItemUuid ? { item: { uuid: activeItemUuid } } : undefined
    },
  },
  navigationController: {
    getNoteFolder: () => undefined,
    setSelectedFolder: () => Promise.resolve(),
    moveNoteToFolder: () => Promise.resolve(),
  },
}

jest.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }))
jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: () => mockApplication }))
jest.mock('@/Hooks/useItemLinks', () => ({ useItemLinks: () => noLinks }))
jest.mock('@/Hooks/useItemVaultInfo', () => ({
  useItemVaultInfo: () => ({ vault: undefined, lastEditedByContact: undefined }),
}))
jest.mock('../Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: () => ({ toggleAppPane: jest.fn() }) }))
jest.mock('@standardnotes/ui-services', () => ({
  FOCUS_TAGS_INPUT_COMMAND: 'focus-tags-input',
  keyboardStringForShortcut: () => 'Ctrl+L',
}))
jest.mock('./ItemLinkAutocompleteInput', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    __esModule: true,
    default: React.forwardRef<HTMLInputElement>((_props, ref) =>
      React.createElement('input', { 'data-link-input': true, ref }),
    ),
  }
})
jest.mock('./LinkedItemBubble', () => ({ __esModule: true, default: () => null }))
jest.mock('../Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('../Vaults/VaultNameBadge', () => ({ __esModule: true, default: () => null }))
jest.mock('../Vaults/LastEditedByBadge', () => ({ __esModule: true, default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Tile = { root: Root; input: HTMLInputElement; focusCount: () => number }

const roots: Root[] = []

/**
 * One mounted NoteView tile holding this note's linking container. Mounted in document
 * order, so "the last one mounted" is the second tile — which is what used to win.
 */
const mountTile = (uuid: string, { inTile = true }: { inTile?: boolean } = {}): Tile => {
  const tile = document.createElement('div')
  if (inTile) {
    tile.setAttribute('data-srn-note-view', uuid)
  }
  document.body.appendChild(tile)
  const host = document.createElement('div')
  tile.appendChild(host)

  const root = createRoot(host)
  roots.push(root)
  act(() => {
    root.render(
      createElement(LinkedItemBubblesContainer, {
        item: { uuid, content_type: 'Note' } as never,
        linkingController: { unlinkItems: jest.fn(), activateItem: jest.fn() } as never,
        readonly: false,
      }),
    )
  })

  const input = host.querySelector<HTMLInputElement>('[data-link-input]') as HTMLInputElement
  // Counted rather than inferred from the final activeElement: every container schedules
  // its focus on a timeout, so "the last one to run wins" could make a wrong-note focus
  // invisible in the end state. A tile that is not the active note must never be focused
  // at all.
  let focuses = 0
  input.addEventListener('focus', () => {
    focuses += 1
  })
  return { root, input, focusCount: () => focuses }
}

const pressTheShortcut = () => {
  act(() => {
    mockApplication.keyboardService.triggerCommand('focus-tags-input')
  })
  // The containers focus on a timeout so the input exists by the time focus lands.
  act(() => {
    jest.runOnlyPendingTimers()
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  document.body.innerHTML = ''
  keyboardHandlers.clear()
  paletteHandlers.clear()
  activeItemUuid = undefined
  roots.length = 0
})

afterEach(() => {
  roots.forEach((root) => act(() => root.unmount()))
  jest.useRealTimers()
})

describe('focusing the link input with more than one note open', () => {
  it('focuses the active note’s input, not the last tile mounted', () => {
    const first = mountTile('note-1')
    const second = mountTile('note-2')
    expect(first.input).not.toBeNull()
    expect(second.input).not.toBeNull()
    // The premise: every container registered a handler, and all of them are called.
    expect(keyboardHandlers.size).toBe(2)

    activeItemUuid = 'note-1'
    pressTheShortcut()

    expect(document.activeElement).toBe(first.input)
    expect(first.focusCount()).toBe(1)
    expect(second.focusCount()).toBe(0)
  })

  it('follows the active note when the user switches tabs', () => {
    const first = mountTile('note-1')
    const second = mountTile('note-2')

    activeItemUuid = 'note-2'
    pressTheShortcut()

    expect(document.activeElement).toBe(second.input)
    expect(second.focusCount()).toBe(1)
    expect(first.focusCount()).toBe(0)
  })

  it('routes the command palette entry to the active note, whichever registration survived', () => {
    const first = mountTile('note-1')
    const second = mountTile('note-2')
    // Only ONE palette registration survives the shared id, and it is the second tile's.
    expect(paletteHandlers.size).toBe(1)

    activeItemUuid = 'note-1'
    act(() => {
      paletteHandlers.get('link-items-current')?.()
    })
    act(() => {
      jest.runOnlyPendingTimers()
    })

    expect(document.activeElement).toBe(first.input)
    expect(second.focusCount()).toBe(0)
  })

  it('still answers unconditionally where there are no tiles to choose between', () => {
    // The file preview modal / clipper / file view render this container outside any note
    // tile, and the active controller item is then not this container's item at all.
    const modal = mountTile('previewed-file', { inTile: false })

    activeItemUuid = 'some-other-note'
    pressTheShortcut()

    expect(document.activeElement).toBe(modal.input)
  })
})
