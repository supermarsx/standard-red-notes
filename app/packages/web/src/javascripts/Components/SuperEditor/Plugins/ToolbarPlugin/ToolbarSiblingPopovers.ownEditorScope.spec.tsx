/**
 * @jest-environment jsdom
 *
 * Standard Red Notes (t112): the two toolbar popovers that live in SIBLING components of
 * ToolbarPlugin must be positioned against their own note's Super editor.
 *
 * `ToolbarPlugin.ownEditorScope.spec.tsx` covers the 29 popovers ToolbarPlugin renders
 * itself. These two are the same cross-tile defect reached by a different route: the AI
 * selection tools (`SelectionTools.tsx`) and the assistant-changes toolbar
 * (`AssistantChangesToolbar.tsx`) passed NO `documentElement` at all, so rather than the
 * wrong note's editor they fell through to `<Popover>`'s own default — `useDocumentRect()`,
 * the whole document — and were sized and flipped against a box that is not any editor's.
 *
 * They get their own file because neither popover is reachable through the full ToolbarPlugin
 * mount: the assistant-changes toolbar returns null until its encrypted ledger says the note
 * is authorized, and the only popover-opening selection actions ('Translate…', 'Ask AI…')
 * live behind subtabs other than the default one. Rendered directly here, with the hooks they
 * read mocked, the two tiles stay the honest part of the setup.
 *
 * Both tests mount TWO `#super-editor` tiles: with one tile a document-wide lookup and an
 * own-editor lookup return the same element and none of this is observable. Containers are
 * asserted by REFERENCE, because two Super editors are structurally identical. Nothing is
 * measured — jsdom has no layout engine, so every dimension would read 0.
 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LexicalEditor } from 'lexical'
import { useApplication } from '@/Components/ApplicationProvider'
import { useResponsiveAppPane } from '@/Components/Panes/ResponsivePaneProvider'
import { useAssistantChangeLedger } from '@/Assistant/useAssistantChangeLedger'
import { ElementIds } from '@/Constants/ElementIDs'
import SelectionTools from './SelectionTools'
import { AssistantChangesToolbar } from './AssistantChangesToolbar'

/** Records the container each popover is handed, by title. See the sibling spec for why. */
type PopoverRecording = { title?: string; documentElement?: HTMLElement }
const mockPopoverRecordings: PopoverRecording[] = []
jest.mock('@/Components/Popover/Popover', () => ({
  __esModule: true,
  default: (props: { title?: string; documentElement?: HTMLElement }) => {
    mockPopoverRecordings.push({ title: props.title, documentElement: props.documentElement })
    return null
  },
}))

jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: jest.fn() }))
jest.mock('@/Components/Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: jest.fn() }))
jest.mock('@/Assistant/useAssistantChangeLedger', () => ({ useAssistantChangeLedger: jest.fn() }))
jest.mock('@/Components/Icon/Icon', () => ({
  __esModule: true,
  default: ({ type }: { type: string }) => <span data-icon={type} />,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const application = {
  addEventObserver: jest.fn(() => () => undefined),
  getPreference: jest.fn((_key: string, fallback: unknown) => fallback),
  hasAccount: jest.fn(() => true),
  sessions: { getUser: jest.fn(() => ({ uuid: 'user-1' })) },
  identifier: 'test',
}

type Tile = {
  /** The `#super-editor` wrapper SuperEditor.tsx puts around one note's editor. */
  superEditor: HTMLElement
  /** Stands in for `editor.getRootElement()`: a node inside this tile's editor. */
  rootElement: HTMLElement
  /** Where a component under test is rendered, inside this tile. */
  host: HTMLElement
}

/** One open note's editor. Plain DOM: what matters is the ancestor chain, not Lexical. */
const mountTile = (noteUuid: string): Tile => {
  const superEditor = document.createElement('div')
  superEditor.id = ElementIds.SuperEditor
  superEditor.setAttribute('data-note', noteUuid)
  document.body.appendChild(superEditor)

  const rootElement = document.createElement('div')
  superEditor.appendChild(rootElement)

  const host = document.createElement('div')
  superEditor.appendChild(host)

  return { superEditor, rootElement, host }
}

/** An editor whose root element is inside `tile` — all either component reads off it here. */
const editorFor = (tile: Tile) =>
  ({
    getRootElement: () => tile.rootElement,
  }) as unknown as LexicalEditor

let root: Root | undefined

beforeEach(() => {
  mockPopoverRecordings.length = 0
  document.body.innerHTML = ''
  root = undefined
  jest.mocked(useApplication).mockReturnValue(application as never)
  jest.mocked(useResponsiveAppPane).mockReturnValue({ presentPane: jest.fn() } as never)
  jest.mocked(useAssistantChangeLedger).mockReturnValue({ authorized: true, note: undefined, records: [] })
})

afterEach(() => {
  if (root) {
    const mounted = root
    act(() => mounted.unmount())
  }
})

const titled = (title: string) => mockPopoverRecordings.filter((recording) => recording.title === title)

describe('the AI selection tools popover with more than one note open', () => {
  /** 'Translate…' and 'Ask AI…' are the only actions that open a popover at all. */
  const openTheSubtabWithAPopoverAction = (within: HTMLElement) => {
    const tab = Array.from(within.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (candidate) => candidate.textContent === 'Transforms',
    )
    expect(tab).toBeDefined()
    act(() => tab!.click())
  }

  it('is positioned against its own note’s editor, not the first open note’s', () => {
    const first = mountTile('note-1')
    const second = mountTile('note-2')
    // The premise: a document-wide lookup cannot tell the editors apart, and `<Popover>`'s
    // own default does not look for one at all.
    expect(document.getElementById(ElementIds.SuperEditor)).toBe(first.superEditor)

    root = createRoot(second.host)
    act(() => {
      root?.render(<SelectionTools editor={editorFor(second)} hasSelection noteUuid="note-2" />)
    })
    openTheSubtabWithAPopoverAction(second.host)

    const recordings = titled('Translate…')
    // A renamed action would otherwise make every assertion below vacuously true.
    expect(recordings.length).toBeGreaterThan(0)
    for (const recording of recordings) {
      expect(recording.documentElement).toBe(second.superEditor)
      expect(recording.documentElement).not.toBe(first.superEditor)
    }
  })
})

describe('the assistant-changes popover with more than one note open', () => {
  it('is positioned against its own note’s editor, not the first open note’s', () => {
    const first = mountTile('note-1')
    const second = mountTile('note-2')
    expect(document.getElementById(ElementIds.SuperEditor)).toBe(first.superEditor)

    root = createRoot(second.host)
    act(() => {
      root?.render(<AssistantChangesToolbar noteUuid="note-2" editor={editorFor(second)} />)
    })

    const recordings = titled('AI changes')
    expect(recordings.length).toBeGreaterThan(0)
    for (const recording of recordings) {
      expect(recording.documentElement).toBe(second.superEditor)
      expect(recording.documentElement).not.toBe(first.superEditor)
    }
  })
})
