/**
 * @jest-environment jsdom
 *
 * Render contract for the navigation sidebar. Per this repo's repeat
 * "serializes/typechecks green but never renders" failure, the sidebar is not
 * done until its UI is proven to reach the DOM. We mount the REAL component inside
 * a real LexicalComposer (with a RichTextPlugin so the editor renders its nodes,
 * which is what `getElementByKey` needs) seeded with headings + a bookmark anchor,
 * and assert:
 *   (a) it renders NOTHING when navigation.visible is false;
 *   (b) when visible, it renders the heading outline (indented by level) + a
 *       Bookmarks section joined from the note's appData;
 *   (c) clicking a heading scrolls its editor element into view (getElementByKey);
 *   (d) the popover's DOM-event bridge toggles visibility live.
 */
import { createElement, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { act } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getRoot, $createParagraphNode, $createTextNode, LexicalEditor } from 'lexical'
import { $createHeadingNode, HeadingNode, QuoteNode } from '@lexical/rich-text'
import ApplicationProvider from '@/Components/ApplicationProvider'
import { STYLED_BLOCK_NODE_OVERRIDES } from '../../Lexical/Nodes/StyledBlockNodes'
import { BookmarkAnchorNode, $createBookmarkAnchorNode } from '../../Lexical/Nodes/BookmarkAnchorNode'
import { DEFAULT_NOTE_LAYOUT, saveNoteLayout } from '../../Layout/layoutSettings'
import NavigationSidebar, { NAVIGATION_LAYOUT_CHANGED_EVENT } from './NavigationSidebarPlugin'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NODES = [HeadingNode, QuoteNode, ...STYLED_BLOCK_NODE_OVERRIDES, BookmarkAnchorNode]

const NOTE_UUID = 'note-under-test'

// A minimal fake note whose appData carries one bookmark matching the seeded anchor.
const fakeNote = {
  uuid: NOTE_UUID,
  getAppDomainValue: (_key: unknown) => [
    { id: 'bm-1', label: 'My Marked Spot', anchor: { kind: 'super', bookmarkId: 'bm-1' }, createdAt: '2020-01-01T00:00:00.000Z' },
  ],
}

// Minimal fake WebApplication surface the sidebar reads.
const fakeApp = {
  itemListController: { activeControllerItem: { uuid: NOTE_UUID } },
  items: { findItem: (uuid: string) => (uuid === NOTE_UUID ? fakeNote : undefined) },
} as never

let capturedEditor: LexicalEditor
function CapturePlugin({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    onReady(editor)
  }, [editor, onReady])
  return null
}

let container: HTMLElement
let root: Root
let scrollIntoViewSpy: jest.Mock
let originalMatchMedia: typeof window.matchMedia
let originalScrollIntoView: typeof Element.prototype.scrollIntoView

beforeEach(() => {
  localStorage.clear()
  originalMatchMedia = window.matchMedia
  // jsdom has no matchMedia; useMediaQuery(sm) must report NOT mobile (desktop).
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia

  originalScrollIntoView = Element.prototype.scrollIntoView
  scrollIntoViewSpy = jest.fn()
  Element.prototype.scrollIntoView = scrollIntoViewSpy

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.matchMedia = originalMatchMedia
  Element.prototype.scrollIntoView = originalScrollIntoView
  localStorage.clear()
})

/** Seed the editor with two headings and a paragraph carrying a bookmark anchor. */
function seedDocument(editor: LexicalEditor) {
  editor.update(
    () => {
      const rootNode = $getRoot()
      rootNode.clear()
      const h1 = $createHeadingNode('h1')
      h1.append($createTextNode('Introduction'))
      const h2 = $createHeadingNode('h2')
      h2.append($createTextNode('Details'))
      const p = $createParagraphNode()
      p.append($createTextNode('body '))
      p.append($createBookmarkAnchorNode('bm-1'))
      rootNode.append(h1)
      rootNode.append(h2)
      rootNode.append(p)
    },
    { discrete: true },
  )
}

function mount() {
  act(() => {
    root.render(
      createElement(ApplicationProvider, {
        application: fakeApp,
        children: createElement(
          LexicalComposer,
          {
            initialConfig: {
              namespace: 'NavSidebarSpec',
              nodes: NODES,
              editorState: null,
              onError: (e: Error) => {
                throw e
              },
            },
          },
          createElement(RichTextPlugin, {
            contentEditable: createElement(ContentEditable, {}),
            placeholder: null,
            ErrorBoundary: LexicalErrorBoundary,
          }),
          createElement(CapturePlugin, {
            onReady: (editor: LexicalEditor) => {
              capturedEditor = editor
              seedDocument(editor)
            },
          }),
          createElement(NavigationSidebar, {}),
        ),
      }),
    )
  })
}

describe('NavigationSidebar', () => {
  it('renders nothing when navigation.visible is false (default)', () => {
    mount()
    expect(container.querySelector('[data-navigation-sidebar]')).toBeNull()
  })

  it('renders the heading outline (indented by level) and a Bookmarks section when visible', () => {
    saveNoteLayout(NOTE_UUID, { ...DEFAULT_NOTE_LAYOUT, navigation: { visible: true, showBookmarks: true } })
    mount()

    const aside = container.querySelector('[data-navigation-sidebar]')
    expect(aside).not.toBeNull()

    const headings = Array.from(container.querySelectorAll('[data-outline-heading]')) as HTMLElement[]
    expect(headings.map((h) => h.textContent)).toEqual(['Introduction', 'Details'])
    // Level encodes indentation: h1 = 8px, h2 = 20px left padding.
    expect(headings[0].style.paddingLeft).toBe('8px')
    expect(headings[1].style.paddingLeft).toBe('20px')

    // Bookmarks section: label joined from the note's appData.
    expect(aside?.textContent).toContain('Bookmarks')
    const bookmarks = Array.from(container.querySelectorAll('[data-outline-bookmark]')) as HTMLElement[]
    expect(bookmarks).toHaveLength(1)
    expect(bookmarks[0].textContent).toContain('My Marked Spot')
  })

  it('scrolls the editor element into view when a heading is clicked', () => {
    saveNoteLayout(NOTE_UUID, { ...DEFAULT_NOTE_LAYOUT, navigation: { visible: true, showBookmarks: true } })
    mount()

    scrollIntoViewSpy.mockClear()
    const firstHeading = container.querySelector('[data-outline-heading]') as HTMLButtonElement
    expect(firstHeading).not.toBeNull()
    act(() => {
      firstHeading.click()
    })
    expect(scrollIntoViewSpy).toHaveBeenCalled()
  })

  it('toggles visibility live via the NAVIGATION_LAYOUT_CHANGED_EVENT bridge', () => {
    // Starts hidden (no persisted visibility).
    mount()
    expect(container.querySelector('[data-navigation-sidebar]')).toBeNull()

    act(() => {
      capturedEditor
        .getRootElement()
        ?.dispatchEvent(
          new CustomEvent(NAVIGATION_LAYOUT_CHANGED_EVENT, { detail: { visible: true, showBookmarks: true } }),
        )
    })

    expect(container.querySelector('[data-navigation-sidebar]')).not.toBeNull()
    expect(container.querySelectorAll('[data-outline-heading]').length).toBeGreaterThan(0)
  })
})
