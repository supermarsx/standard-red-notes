/** @jest-environment jsdom */
/**
 * The row the note-header linking popover renders for each search result.
 *
 * A folder result reaches `getIconForItem`, which knew only notes, files, tags and
 * smart views and ended in a `throw` — so offering folders in that input without
 * teaching it about them takes the whole popover down mid-render, with tsc and any
 * Icon-stubbing spec blind to it. `Icon` is deliberately NOT stubbed here: an icon name
 * that resolves to no glyph falls through to the emoji path and renders the name itself
 * as a <label>, which is how three wrong icon names have already shipped.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { FolderContentType } from '@standardnotes/snjs'
import LinkedItemMeta from './LinkedItemMeta'
import { LinkableItem } from '@/Utils/Items/Search/LinkableItem'

const mockApplication = {
  items: {
    getTagPrefixTitle: jest.fn(),
    getTagLongTitle: jest.fn(),
  },
}

jest.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }))
jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: () => mockApplication }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const folder = (title: string, iconString = 'folder') =>
  ({
    uuid: `folder-${title}`,
    title,
    iconString,
    content_type: FolderContentType,
    references: [],
  }) as unknown as LinkableItem

describe('LinkedItemMeta with a folder result', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders the folder row instead of throwing out of the popover', () => {
    act(() => root.render(createElement(LinkedItemMeta, { item: folder('Work') })))

    expect(container.textContent).toContain('Work')
  })

  it('draws a real glyph rather than printing the icon name as text', () => {
    act(() => root.render(createElement(LinkedItemMeta, { item: folder('Work') })))

    expect(container.querySelector('label')).toBeNull()
    expect(container.textContent).not.toContain('folder')
  })

  it('prints no raw text for a folder icon that resolves to no glyph', () => {
    act(() => root.render(createElement(LinkedItemMeta, { item: folder('Work', 'briefcase') })))

    expect(container.querySelector('label')).toBeNull()
    expect(container.textContent).toBe('Work')
  })

  it('still renders an emoji folder icon, which deliberately has no mapping', () => {
    act(() => root.render(createElement(LinkedItemMeta, { item: folder('Work', '📁') })))

    expect(container.querySelector('label')?.textContent).toBe('📁')
  })

  it('highlights the matched part of the folder title like any other result', () => {
    act(() => root.render(createElement(LinkedItemMeta, { item: folder('Work'), searchQuery: 'Wor' })))

    const bold = Array.from(container.querySelectorAll('span')).filter((span) => span.className.includes('font-bold'))

    expect(bold.map((span) => span.textContent)).toContain('Wor')
  })
})
