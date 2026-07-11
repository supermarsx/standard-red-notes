/**
 * @jest-environment jsdom
 *
 * Render contract / vanish-guard for `InsertSectionsBar` (task t41): the Insert
 * tab's general dropdown was replaced by always-visible captioned catalog
 * sections. The real sections render deep inside the un-mountable ToolbarPlugin,
 * so — per this repo's repeat "renders green but the section silently vanished"
 * failure — this pure, provider-free component is the mandatory render-path
 * guard: given fake `sections`, EVERY caption and a representative button from
 * each section MUST appear in the DOM.
 */
import { createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { act } from 'react'
import InsertSectionsBar from '@/Components/SuperEditor/Plugins/ToolbarPlugin/InsertSectionsBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

// Seven sections, mirroring the real Insert tab's shape (captions + one button
// per section; "others" carries an extra appended action button).
const CAPTIONS = ['Basic', 'Lists', 'Media', 'Data & tables', 'Diagrams & charts', 'Finance', 'Others']

const makeSections = () =>
  CAPTIONS.map((caption, index) => ({
    key: `section-${index}`,
    caption,
    rows: [
      [
        createElement('button', { key: 'a', type: 'button' }, `${caption} item`),
        ...(caption === 'Others' ? [createElement('button', { key: 'b', type: 'button' }, 'Link')] : []),
      ],
    ],
  }))

const render = () => {
  act(() => {
    root.render(createElement(InsertSectionsBar, { sections: makeSections() }))
  })
}

describe('InsertSectionsBar', () => {
  it('renders all seven section captions', () => {
    render()
    for (const caption of CAPTIONS) {
      expect(container.textContent).toContain(caption)
    }
  })

  it('renders a representative button from every section (nothing dropped)', () => {
    render()
    const buttonLabels = Array.from(container.querySelectorAll('button')).map((button) => button.textContent)
    for (const caption of CAPTIONS) {
      expect(buttonLabels).toContain(`${caption} item`)
    }
    // The action button appended to "Others" is present too.
    expect(buttonLabels).toContain('Link')
  })

  it('renders one super-toolbar-group segment per section, each labelled by its caption', () => {
    render()
    const segments = Array.from(container.querySelectorAll('[role="group"]'))
    expect(segments.length).toBe(CAPTIONS.length)
    for (const caption of CAPTIONS) {
      expect(segments.some((segment) => segment.getAttribute('aria-label') === caption)).toBe(true)
    }
    // Visual parity with normal ribbon groups: the segment carries the shared class.
    expect(segments.every((segment) => segment.className.includes('super-toolbar-group'))).toBe(true)
  })

  it('renders nothing but a fragment (no wrapper element) for an empty section list', () => {
    act(() => {
      root.render(createElement(InsertSectionsBar, { sections: [] }))
    })
    expect(container.querySelectorAll('[role="group"]').length).toBe(0)
  })
})
