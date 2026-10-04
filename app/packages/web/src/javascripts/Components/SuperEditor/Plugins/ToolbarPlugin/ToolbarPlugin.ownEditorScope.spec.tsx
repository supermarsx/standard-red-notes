/**
 * @jest-environment jsdom
 *
 * Standard Red Notes (t112): the toolbar must resolve ITS OWN note's Super editor.
 *
 * `#super-editor` is not unique. NoteGroupView keeps every open tab mounted and merely
 * hides the inactive ones, so from the second open note onward `document.getElementById`
 * answers "whichever note's editor is first in the document". Two places in ToolbarPlugin
 * used that lookup:
 *
 *  - the root-blur handler, which decides whether focus is leaving the editor. Judged
 *    against another note's editor it got BOTH directions wrong: a click landing inside
 *    this note's own editor read as "focus left" (the mobile toolbar collapsed mid-edit),
 *    and a click landing in the OTHER note's editor read as "focus stayed".
 *  - `popoverDocumentElement`, the container all 29 toolbar popovers are positioned
 *    against and portalled into. The first tile may be the HIDDEN one, in which case the
 *    popover renders into `display: none` and the user sees nothing.
 *
 * Both now walk UP from the toolbar's own Lexical root via `ownSuperEditorElements`, so the
 * answer is the asking tile's editor by construction.
 *
 * Every test mounts TWO tiles: with one tile the id lookup and the own-editor lookup return
 * the same element and none of this is observable. Containers are compared by REFERENCE,
 * because two mounted Super editors are structurally identical. Nothing is measured — jsdom
 * has no layout engine, so every dimension would read 0.
 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ToolbarPlugin from './ToolbarPlugin'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from '../../Constants'
import { MutuallyExclusiveMediaQueryBreakpoints } from '@/Hooks/useMediaQuery'

/**
 * The popover container is a value handed to every `<Popover>` the toolbar renders — 29 from
 * ToolbarPlugin itself plus the AI selection tools and the assistant-changes toolbar — and
 * none of them is open on mount, so the only way to read it without driving that many
 * separate pieces of state is to record what the real components actually pass. The stub
 * renders nothing: a closed popover renders nothing either, and the point here is the
 * container it was given, not its contents. The `title` is recorded alongside so a popover
 * can be named in a failure, and so "nobody was left on the document-wide default" is an
 * assertion about ALL of them rather than about a filtered subset. Named `mock…` so the
 * jest.mock factory may reference it after hoisting.
 */
type PopoverRecording = { title?: string; documentElement?: HTMLElement }
const mockPopoverRecordings: PopoverRecording[] = []
jest.mock('@/Components/Popover/Popover', () => ({
  __esModule: true,
  default: (props: { title?: string; documentElement?: HTMLElement }) => {
    mockPopoverRecordings.push({ title: props.title, documentElement: props.documentElement })
    return null
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
/**
 * Mounting the real 5000-line ToolbarPlugin in jsdom costs seconds, and this file mounts it
 * TWICE per test (one tile is not enough to tell the two lookups apart). Precedent for the
 * raised timeout: the five other specs in this directory that mount it once. This is
 * headroom for a slow mount, not a wait for anything async.
 */
jest.setTimeout(60000)

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const fakeApp = {
  getPreference: (key: string, fallback: unknown) => PrefDefaults[key as PrefKey] ?? fallback,
  preferences: {
    getLocalValue: (key: string, fallback: unknown) => LocalPrefDefaults[key as never] ?? fallback,
    setLocalValue: () => undefined,
  },
  addEventObserver: () => () => undefined,
  addAndroidBackHandlerEventListener: () => () => undefined,
  setAndroidBackHandlerFallbackListener: () => undefined,
  addNativeMobileEventListener: () => () => undefined,
  isAuthorizedToRenderItem: () => true,
  vaultLocks: { addEventObserver: () => () => undefined },
  items: { streamItems: () => () => undefined, addObserver: () => () => undefined },
  keyboardService: { addCommandHandler: () => () => undefined },
} as never

type Tile = {
  /** The `#super-editor` wrapper SuperEditor.tsx puts around one note's editor. */
  superEditor: HTMLElement
  /** The Lexical contenteditable, i.e. `editor.getRootElement()` for this tile. */
  rootElement: HTMLElement
  /**
   * A node inside this tile's `#super-editor` but OUTSIDE its toolbar container — what a
   * link popover's input is, from the blur handler's point of view.
   */
  insideOwnEditor: HTMLElement
  toolbarContainer: HTMLElement
  unmount: () => Promise<void>
}

const tiles: Tile[] = []

/** One mounted NoteView: its own `#super-editor`, its own editor, its own toolbar. */
const mountTile = async (noteUuid: string): Promise<Tile> => {
  const superEditor = document.createElement('div')
  superEditor.id = ElementIds.SuperEditor
  superEditor.setAttribute('data-note', noteUuid)
  document.body.appendChild(superEditor)

  const host = document.createElement('div')
  superEditor.appendChild(host)

  const insideOwnEditor = document.createElement('div')
  superEditor.appendChild(insideOwnEditor)

  const root: Root = createRoot(host)
  await act(async () => {
    root.render(
      <ApplicationProvider application={fakeApp}>
        <AndroidBackHandlerProvider application={fakeApp}>
          <BlocksEditorComposer initialValue={undefined}>
            <ToolbarPlugin noteUuid={noteUuid} />
            {/*
              Wrapped in a plain div on purpose: it makes the contenteditable's
              `parentElement` something OTHER than `#super-editor`, so a lookup that
              settled for the parent instead of walking up to the editor would not
              accidentally satisfy the assertions below.
            */}
            <div>
              <ContentEditable id={SuperEditorContentId} />
            </div>
          </BlocksEditorComposer>
        </AndroidBackHandlerProvider>
      </ApplicationProvider>,
    )
    await Promise.resolve()
  })

  const rootElement = host.querySelector<HTMLElement>(`#${SuperEditorContentId}`) as HTMLElement
  const toolbarContainer = host.querySelector<HTMLElement>('#super-mobile-toolbar') as HTMLElement

  const tile: Tile = {
    superEditor,
    rootElement,
    insideOwnEditor,
    toolbarContainer,
    unmount: async () => {
      await act(async () => root.unmount())
      superEditor.remove()
    },
  }
  tiles.push(tile)
  return tile
}

const dispatchOnRoot = async (tile: Tile, event: FocusEvent) => {
  await act(async () => {
    tile.rootElement.dispatchEvent(event)
    await Promise.resolve()
  })
}

const focusEditor = (tile: Tile) => dispatchOnRoot(tile, new FocusEvent('focus'))
const blurEditorTowards = (tile: Tile, relatedTarget: Element) =>
  dispatchOnRoot(tile, new FocusEvent('blur', { relatedTarget }))

/** The mobile toolbar collapses by class, not by unmounting. */
const isToolbarShowing = (tile: Tile) => !tile.toolbarContainer.classList.contains('hidden')

beforeEach(() => {
  mockPopoverRecordings.length = 0
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  // Mobile layout: it is the only layout in which the focus state the blur handler
  // maintains is observable at all (`isMobile && !canShowToolbarOnMobile` is what puts
  // `hidden` on the toolbar container). Declared, never measured.
  window.matchMedia = ((query: string) => ({
    matches: query === MutuallyExclusiveMediaQueryBreakpoints.sm,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

afterEach(async () => {
  for (const tile of tiles.splice(0, tiles.length).reverse()) {
    await tile.unmount()
  }
  document.body.innerHTML = ''
})

describe('the root-blur handler with more than one note open', () => {
  it('keeps focus when it moves to this note’s own editor, not the first open note’s', async () => {
    const first = await mountTile('note-1')
    const second = await mountTile('note-2')
    // The premise: an id lookup cannot tell the two editors apart and answers the first.
    expect(document.getElementById(ElementIds.SuperEditor)).toBe(first.superEditor)
    expect(second.superEditor).not.toBe(first.superEditor)

    await focusEditor(second)
    expect(isToolbarShowing(second)).toBe(true)

    // Focus moves into the second note's OWN editor — a link popover's input, say. That is
    // still inside the editor, so the toolbar must stay up. Resolved document-wide this
    // node belongs to no editor the handler knows about, and the toolbar collapses.
    await blurEditorTowards(second, second.insideOwnEditor)
    expect(isToolbarShowing(second)).toBe(true)
  })

  it('lets focus go when it moves into a DIFFERENT note’s editor', async () => {
    const first = await mountTile('note-1')
    const second = await mountTile('note-2')
    expect(document.getElementById(ElementIds.SuperEditor)).toBe(first.superEditor)

    await focusEditor(second)
    expect(isToolbarShowing(second)).toBe(true)

    // The other note's editor is not this editor. Resolved document-wide it IS the one the
    // handler looks at, so focus would be reported as never having left.
    await blurEditorTowards(second, first.insideOwnEditor)
    expect(isToolbarShowing(second)).toBe(false)
  })

  it('answers the same way for the first tile, which is the control', async () => {
    // For the FIRST open note the id lookup and the own-editor lookup agree, which is why
    // this was invisible until a second note was opened. Asserted so the pair above cannot
    // be read as "tile 2 is special".
    const first = await mountTile('note-1')
    const second = await mountTile('note-2')

    await focusEditor(first)
    expect(isToolbarShowing(first)).toBe(true)

    await blurEditorTowards(first, first.insideOwnEditor)
    expect(isToolbarShowing(first)).toBe(true)

    await blurEditorTowards(first, second.insideOwnEditor)
    expect(isToolbarShowing(first)).toBe(false)
  })
})

/**
 * The popover container is computed during render, and on the very FIRST render the Lexical
 * root does not exist yet — `ContentEditable` attaches it from a ref callback, in that same
 * commit — so the first pass legitimately lands on the helper's `document.body` last resort.
 * Nothing reads it then: every popover is closed, and opening any of them is a state change,
 * which is another render. The value under test is therefore the one from a render AFTER the
 * editor exists, which is what this drives, discarding the first pass.
 */
const popoverContainersAfterTheEditorExists = async (mounted: Tile[]) => {
  const outsideAnyEditor = document.createElement('div')
  document.body.appendChild(outsideAnyEditor)

  for (const tile of mounted) {
    await focusEditor(tile)
  }
  mockPopoverRecordings.length = 0
  for (const tile of mounted) {
    // true -> false is a real state change, so each toolbar re-renders exactly once.
    await blurEditorTowards(tile, outsideAnyEditor)
  }

  return [...mockPopoverRecordings]
}

/**
 * Popovers knowingly left on the document-wide default, by title. `BlockStyleGallery.tsx`
 * does not import lexical at all and its popover sits two component layers deep inside it, so
 * scoping it means threading a new editor prop through a public component's API — a design
 * call, not a swap. Carved out BY NAME, and asserted below, so the exclusion cannot silently
 * grow to cover a popover that regressed.
 */
const POPOVERS_WITH_NO_EDITOR_IN_SCOPE = new Set<string | undefined>(['More block styles'])

/** Names an element for a readable failure; two mounted editors are otherwise identical. */
const describeContainer = (first: Tile, second: Tile) => (element: HTMLElement | undefined) => {
  if (element === undefined) {
    // What `<Popover>` falls back to on its own: `useDocumentRect()`, the whole document.
    return 'the whole document (no documentElement given)'
  }
  if (element === first.superEditor) {
    return 'first note’s editor'
  }
  if (element === second.superEditor) {
    return 'second note’s editor'
  }
  return `${element.tagName}#${element.id || '(no id)'}`
}

describe('the container every toolbar popover is positioned against', () => {
  it('is the asking toolbar’s own editor, so each tile gets a different one', async () => {
    const first = await mountTile('note-1')
    const second = await mountTile('note-2')
    expect(document.getElementById(ElementIds.SuperEditor)).toBe(first.superEditor)

    const recordings = await popoverContainersAfterTheEditorExists([first, second])
    expect(recordings.length).toBeGreaterThan(0)

    // The whole point, in one assertion: BOTH editors appear, and nothing else does.
    // Resolved document-wide, every popover in both toolbars is handed the FIRST note's
    // editor, so this set is `{first note’s editor}` — and the second note's popovers
    // render into, and are clamped to, a box that is not theirs. A popover given no
    // container at all shows up here too, as "the whole document".
    const label = describeContainer(first, second)
    const scoped = recordings.filter((recording) => !POPOVERS_WITH_NO_EDITOR_IN_SCOPE.has(recording.title))
    expect(new Set(scoped.map((recording) => label(recording.documentElement)))).toEqual(
      new Set(['first note’s editor', 'second note’s editor']),
    )
    expect(scoped.map((recording) => recording.documentElement)).toContain(second.superEditor)
  })

  it('is still missing from the overflow block-style gallery, which has no editor at all', async () => {
    // The carve-out above, asserted rather than assumed: if BlockStyleGallery is ever given
    // an editor, this fails and the exclusion must be deleted instead of quietly widening.
    const first = await mountTile('note-1')
    const second = await mountTile('note-2')

    const recordings = await popoverContainersAfterTheEditorExists([first, second])
    const carvedOut = recordings.filter((recording) => POPOVERS_WITH_NO_EDITOR_IN_SCOPE.has(recording.title))

    expect(carvedOut.length).toBeGreaterThan(0)
    expect(carvedOut.map((recording) => recording.documentElement)).toEqual(carvedOut.map(() => undefined))
  })

  it('is the `#super-editor` itself, not the contenteditable’s parent', async () => {
    const first = await mountTile('note-1')
    const second = await mountTile('note-2')

    const containers = (await popoverContainersAfterTheEditorExists([first, second])).map(
      (recording) => recording.documentElement,
    )

    // `editor.getRootElement()?.parentElement` is the expression the old code fell back to
    // second. It is a real element, so a lookup that stopped there would look like it
    // worked while still not being the editor box the popover is clamped against.
    expect(first.rootElement.parentElement).not.toBe(first.superEditor)
    expect(containers).not.toContain(first.rootElement.parentElement)
    expect(containers).not.toContain(second.rootElement.parentElement)
    expect(containers).not.toContain(document.body)
  })
})
