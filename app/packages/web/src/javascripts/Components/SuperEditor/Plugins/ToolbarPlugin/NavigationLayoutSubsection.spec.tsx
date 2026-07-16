/**
 * @jest-environment jsdom
 *
 * Render contract for the Navigation subsection of the page-layout popover.
 *
 * The full ToolbarPlugin closes over deep editor state and cannot be jsdom-mounted
 * (that is why the vanish guards for the other subsections are static-source
 * assertions). To get REAL render evidence for this subsection — per this repo's
 * repeat "typechecks green but never renders" failure (MEMORY: verify UI render
 * paths; the Page group vanished twice) — the subsection lives in its own small
 * component that the popover renders, and we mount THAT actual component here:
 *   (a) the "Navigation sidebar" toggle always renders; the "Show bookmarks"
 *       toggle only appears once the sidebar is enabled;
 *   (b) toggling each checkbox calls onChange with the right navigation patch;
 *   (c) applyNavigationPatch — the shared helper `setNavigation` calls — persists
 *       via updateNoteLayout AND dispatches NAVIGATION_LAYOUT_CHANGED_EVENT so the
 *       live sidebar re-syncs (this is the popover↔sidebar bridge contract).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { NavigationSettings, NoteLayout } from '../../Layout/layoutSettings'
import { NAVIGATION_LAYOUT_CHANGED_EVENT } from '../NavigationSidebarPlugin/NavigationSidebarPlugin'
import { NavigationLayoutSubsection, applyNavigationPatch } from './NavigationLayoutSubsection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function mount(navigation: NavigationSettings, onChange: (patch: Partial<NavigationSettings>) => void) {
  act(() => {
    root.render(createElement(NavigationLayoutSubsection, { navigation, onChange }))
  })
}

const checkboxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('NavigationLayoutSubsection (jsdom render)', () => {
  it('renders the Navigation card + the sidebar toggle, with the on-screen-only sub-copy', () => {
    mount({ visible: false, showBookmarks: true }, () => {})
    expect(container.textContent).toContain('Navigation sidebar')
    expect(container.textContent).toContain('on-screen only')
    // The card mirrors the sibling subsections' bordered styling.
    expect(container.querySelector('.rounded-md.border.border-border')).not.toBeNull()
  })

  it('hides the "Show bookmarks" toggle until the sidebar is enabled', () => {
    mount({ visible: false, showBookmarks: true }, () => {})
    expect(container.textContent).not.toContain('Show bookmarks in the sidebar')
    expect(checkboxes()).toHaveLength(1)
  })

  it('reveals BOTH toggles when the sidebar is visible, reflecting checked state', () => {
    mount({ visible: true, showBookmarks: true }, () => {})
    expect(container.textContent).toContain('Show bookmarks in the sidebar')
    const boxes = checkboxes()
    expect(boxes).toHaveLength(2)
    expect(boxes[0].checked).toBe(true) // sidebar visible
    expect(boxes[1].checked).toBe(true) // show bookmarks
  })

  it('calls onChange({ visible: true }) when the sidebar toggle is checked', () => {
    const onChange = jest.fn()
    mount({ visible: false, showBookmarks: true }, onChange)
    act(() => {
      checkboxes()[0].click()
    })
    expect(onChange).toHaveBeenCalledWith({ visible: true })
  })

  it('calls onChange({ showBookmarks: false }) when the bookmarks toggle is unchecked', () => {
    const onChange = jest.fn()
    mount({ visible: true, showBookmarks: true }, onChange)
    act(() => {
      checkboxes()[1].click()
    })
    expect(onChange).toHaveBeenCalledWith({ showBookmarks: false })
  })
})

describe('applyNavigationPatch (popover→sidebar bridge)', () => {
  it('persists the merged navigation via updateNoteLayout AND dispatches NAVIGATION_LAYOUT_CHANGED_EVENT', () => {
    const updateNoteLayout = jest.fn<void, [Partial<NoteLayout>]>()
    const rootElement = document.createElement('div')
    let receivedDetail: NavigationSettings | undefined
    rootElement.addEventListener(NAVIGATION_LAYOUT_CHANGED_EVENT, (event) => {
      receivedDetail = (event as CustomEvent<NavigationSettings>).detail
    })

    applyNavigationPatch({ visible: false, showBookmarks: true }, { visible: true }, updateNoteLayout, rootElement)

    // Merged with the previous navigation, not just the patch.
    expect(updateNoteLayout).toHaveBeenCalledWith({ navigation: { visible: true, showBookmarks: true } })
    expect(receivedDetail).toEqual({ visible: true, showBookmarks: true })
  })

  it('still persists (and simply skips the dispatch) when the editor root is null', () => {
    const updateNoteLayout = jest.fn<void, [Partial<NoteLayout>]>()
    expect(() =>
      applyNavigationPatch({ visible: true, showBookmarks: true }, { showBookmarks: false }, updateNoteLayout, null),
    ).not.toThrow()
    expect(updateNoteLayout).toHaveBeenCalledWith({ navigation: { visible: true, showBookmarks: false } })
  })
})
