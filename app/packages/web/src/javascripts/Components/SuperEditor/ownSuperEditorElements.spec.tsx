/**
 * @jest-environment jsdom
 *
 * Standard Red Notes (t112): a Super editor popover must attach to, and be positioned
 * against, the editor it belongs to.
 *
 * `#super-editor` and `#super-editor-content` are rendered once per open note — from the
 * second open tab onward the tiled editor mounts one NoteView per note and merely hides
 * the inactive ones. Resolving either by id therefore answered "the first open note's
 * editor", so the link popover was portalled into a DIFFERENT note's editor subtree (and
 * in single-tile layout that subtree carries `hidden`, so the popover rendered invisibly),
 * and the image toolbar was clamped to a different note's editor box.
 *
 * Every test mounts TWO tiles; with one tile the id lookup and the own-editor lookup return
 * the same element and none of this is observable. Containers are asserted by reference
 * (`toBe`), because two mounted Super editors are structurally identical.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LexicalEditor } from 'lexical'
import { LinkNode } from '@lexical/link'
import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from './Constants'
import { superEditorPortalTarget } from './ownSuperEditorElements'
import ImageToolbar from './Plugins/ImageTools/ImageToolbar'
import SuperEmbeddedImage from './Plugins/ImageTools/SuperEmbeddedImage'
import LinkViewer from './Plugins/ToolbarPlugin/LinkViewer'
import LinkEditor from './Plugins/ToolbarPlugin/LinkEditor'
import ImagePreview from '@/Components/FilePreview/ImagePreview'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

jest.mock('@/Hooks/usePreference', () => ({
  __esModule: true,
  default: () => 'left',
}))
jest.mock('@/Components/FilePreview/ZoomableImage', () => ({
  __esModule: true,
  default: 'div',
}))

type Tile = {
  superEditor: HTMLElement
  content: HTMLElement
  rectReads: number
}

/** One mounted NoteView's Super editor, with a declared rect (jsdom has no layout). */
const mountTile = (uuid: string, top: number): Tile => {
  const root = document.createElement('div')
  root.setAttribute('data-srn-note-view', uuid)
  root.innerHTML = `
    <div id="${ElementIds.SuperEditor}">
      <div id="${SuperEditorContentId}"></div>
    </div>
  `
  document.body.appendChild(root)

  const superEditor = root.querySelector<HTMLElement>(`#${ElementIds.SuperEditor}`) as HTMLElement
  const content = root.querySelector<HTMLElement>(`#${SuperEditorContentId}`) as HTMLElement

  const tile: Tile = { superEditor, content, rectReads: 0 }
  content.getBoundingClientRect = () => {
    tile.rectReads += 1
    return { top, bottom: top + 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: top } as DOMRect
  }
  return tile
}

let root: Root | undefined

beforeEach(() => {
  document.body.innerHTML = ''
  root = undefined
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
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  if (root) {
    const mounted = root
    act(() => mounted.unmount())
  }
})

describe('resolving a Super editor from a node inside it', () => {
  it('answers the containing editor, never the first one in the document', () => {
    const first = mountTile('note-1', 10)
    const second = mountTile('note-2', 90)
    // The premise: an id lookup cannot tell the editors apart and answers the first.
    expect(document.getElementById(ElementIds.SuperEditor)).toBe(first.superEditor)

    expect(superEditorPortalTarget(second.content)).toBe(second.superEditor)
    expect(superEditorPortalTarget(first.content)).toBe(first.superEditor)
  })

  it('falls back to the body rather than to another note’s editor', () => {
    mountTile('note-1', 10)
    const orphan = document.createElement('div')
    document.body.appendChild(orphan)

    // Another note's editor is not an approximation of "unknown": it may be the hidden
    // tile, which would render the popover invisible.
    expect(superEditorPortalTarget(orphan)).toBe(document.body)
    expect(superEditorPortalTarget(null)).toBe(document.body)
  })
})

describe('link popover with more than one note open', () => {
  const buildEditor = (rootElement: HTMLElement, linkElement: HTMLElement) =>
    ({
      getEditorState: () => ({
        read: (callback: () => void) => {
          callback()
        },
      }),
      getElementByKey: () => linkElement,
      getRootElement: () => rootElement,
      registerUpdateListener: () => () => {},
      registerCommand: () => () => {},
      dispatchCommand: () => true,
    }) as unknown as LexicalEditor

  it('portals into its own note’s editor, not the first open note’s', () => {
    const first = mountTile('note-1', 10)
    const second = mountTile('note-2', 90)
    expect(document.getElementById(ElementIds.SuperEditor)).toBe(first.superEditor)

    const linkElement = document.createElement('a')
    second.content.appendChild(linkElement)
    const linkNode = { getURL: () => 'https://example.com', getKey: () => 'link-key' } as unknown as LinkNode

    // react-dom needs a mount point of its own; the popover's placement is decided by the
    // portal container, not by where the component itself is rendered.
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        createElement(LinkViewer, {
          editor: buildEditor(second.content, linkElement),
          linkNode,
          isMobile: true,
          setIsEditingLink: () => {},
        }),
      )
    })

    const popover = document.querySelector('a[href="https://example.com"]')?.closest('div.absolute') as HTMLElement
    expect(popover).not.toBeNull()
    expect(second.superEditor.contains(popover)).toBe(true)
    expect(first.superEditor.contains(popover)).toBe(false)
  })

  it('portals the link EDITOR into its own note’s editor too', () => {
    const first = mountTile('note-1', 10)
    const second = mountTile('note-2', 90)
    expect(document.getElementById(ElementIds.SuperEditor)).toBe(first.superEditor)

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        createElement(LinkEditor, {
          editor: buildEditor(second.content, document.createElement('a')),
          setIsEditingLink: () => {},
          isMobile: true,
          linkNode: null,
          linkTextNode: null,
        }),
      )
    })

    const input = document.querySelector('input') as HTMLElement
    expect(input).not.toBeNull()
    expect(second.superEditor.contains(input)).toBe(true)
    expect(first.superEditor.contains(input)).toBe(false)
  })
})

describe('image toolbar boundary with more than one note open', () => {
  it('clamps against its own editor’s box, not the first open note’s', () => {
    const first = mountTile('note-1', 10)
    const second = mountTile('note-2', 90)
    expect(document.getElementById(SuperEditorContentId)).toBe(first.content)

    // The toolbar is rendered inside the second note's editor content, exactly as a
    // selected image's decorator node is.
    const host = document.createElement('div')
    second.content.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        createElement(ImageToolbar, {
          visible: true,
          alignment: 'left' as const,
          onAlignmentChange: () => {},
          onPresetSelect: () => {},
          float: 'none' as const,
          onFloatChange: () => {},
          captionEnabled: false,
          onToggleCaption: () => {},
        }),
      )
    })

    const toolbar = document.querySelector('[data-image-toolbar="true"]') as HTMLElement
    expect(toolbar).not.toBeNull()
    // jsdom reports a zero rect for the toolbar itself, so the overflow it corrects by is
    // the boundary's own top — 90 for the second note, 10 for the first. The value proves
    // which editor was measured, and the read counters prove the first was never touched.
    expect(toolbar.style.getPropertyValue('--tw-translate-y')).toBe('90px')
    expect(second.rectReads).toBeGreaterThan(0)
    expect(first.rectReads).toBe(0)
  })

  it('is clamped to its own editor when rendered by ImagePreview', () => {
    const first = mountTile('note-1', 10)
    const second = mountTile('note-2', 90)
    const host = document.createElement('div')
    second.content.appendChild(host)
    root = createRoot(host)

    act(() => {
      root?.render(
        createElement(ImagePreview, {
          objectUrl: 'blob:image',
          isEmbeddedInSuper: true,
          isImageSelected: true,
          changeAlignment: () => {},
        }),
      )
    })

    const toolbar = document.querySelector('[data-image-toolbar="true"]') as HTMLElement
    expect(toolbar).not.toBeNull()
    expect(toolbar.style.getPropertyValue('--tw-translate-y')).toBe('90px')
    expect(first.rectReads).toBe(0)
  })

  it('is clamped to its own editor when rendered by SuperEmbeddedImage', () => {
    const first = mountTile('note-1', 10)
    const second = mountTile('note-2', 90)
    const host = document.createElement('div')
    second.content.appendChild(host)
    root = createRoot(host)

    act(() => {
      root?.render(
        createElement(SuperEmbeddedImage, {
          src: 'blob:image',
          alignment: 'left' as const,
          onAlignmentChange: () => {},
          width: undefined,
          onWidthChange: () => {},
          caption: undefined,
          onCaptionChange: () => {},
          float: 'none' as const,
          onFloatChange: () => {},
          isSelected: true,
        }),
      )
    })

    const toolbar = document.querySelector('[data-image-toolbar="true"]') as HTMLElement
    expect(toolbar).not.toBeNull()
    expect(toolbar.style.getPropertyValue('--tw-translate-y')).toBe('90px')
    expect(first.rectReads).toBe(0)
  })
})
