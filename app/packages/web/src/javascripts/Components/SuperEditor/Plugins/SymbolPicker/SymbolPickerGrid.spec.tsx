/**
 * @jest-environment jsdom
 *
 * Render contract / vanish-guard for `SymbolPickerGrid` (task t62). The live
 * picker renders inside a modal opened from the un-mountable ToolbarPlugin /
 * slash picker, so — per this repo's repeat "renders green but silently
 * vanished" failure — this pure, provider-free component is the mandatory
 * render-path guard: given fake categories, EVERY caption and a representative
 * symbol button MUST appear, clicking one fires onInsert, and typing in search
 * fires onQueryChange.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import SymbolPickerGrid, { SymbolPickerGridProps } from '@/Components/SuperEditor/Plugins/SymbolPicker/SymbolPickerGrid'

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

const LABELS = { search: 'Search symbols', recents: 'Recently used', noResults: 'No symbols found' }

const CATEGORIES = [
  {
    name: 'Common',
    symbols: [
      { char: '©', name: 'Copyright' },
      { char: '™', name: 'Trademark' },
    ],
  },
  { name: 'Arrows', symbols: [{ char: '→', name: 'Rightwards arrow' }] },
]

const render = (overrides: Partial<SymbolPickerGridProps> = {}) => {
  const props: SymbolPickerGridProps = {
    query: '',
    onQueryChange: () => undefined,
    categories: CATEGORIES,
    recents: [],
    onInsert: () => undefined,
    labels: LABELS,
    ...overrides,
  }
  act(() => {
    root.render(createElement(SymbolPickerGrid, props))
  })
}

describe('SymbolPickerGrid', () => {
  it('renders every category caption', () => {
    render()
    expect(container.textContent).toContain('Common')
    expect(container.textContent).toContain('Arrows')
  })

  it('renders a symbol button per symbol (nothing dropped)', () => {
    render()
    for (const char of ['©', '™', '→']) {
      expect(container.querySelector(`[data-symbol="${char}"]`)).not.toBeNull()
    }
  })

  it('fires onInsert with the char when a symbol button is clicked', () => {
    const inserted: string[] = []
    render({ onInsert: (char) => inserted.push(char) })
    const button = container.querySelector<HTMLButtonElement>('[data-symbol="→"]')
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(inserted).toEqual(['→'])
  })

  it('fires onQueryChange when the search box changes', () => {
    const changes: string[] = []
    render({ onQueryChange: (query) => changes.push(query) })
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')
    expect(input).not.toBeNull()
    // React tracks the input's value via a native setter; bypass it so the
    // synthetic onChange fires (setting `.value` directly would be a no-op).
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      nativeSetter?.call(input, 'arrow')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(changes).toContain('arrow')
  })

  it('shows the recents row only when there are recents and no active query', () => {
    render({ recents: ['Ω'], query: '' })
    expect(container.querySelector('[data-testid="symbol-recents"]')).not.toBeNull()
    expect(container.textContent).toContain('Recently used')

    render({ recents: ['Ω'], query: 'arrow' })
    expect(container.querySelector('[data-testid="symbol-recents"]')).toBeNull()
  })

  it('shows the no-results message when there are no categories', () => {
    render({ categories: [], query: 'zzz' })
    expect(container.textContent).toContain('No symbols found')
  })
})
