/**
 * @jest-environment jsdom
 *
 * The Mermaid block's size controls, rendered for real.
 *
 * What this file is for, and what it deliberately does NOT claim:
 *  - It proves the section is ON SCREEN (in the DOM) only while `visible`, that
 *    the field applies a parseable width, that an UNPARSEABLE entry is reported
 *    and NOT applied, and that clearing the field returns to fitting.
 *  - It does NOT assert any rendered geometry. jsdom has no layout engine, so
 *    every width/height/rect here reports 0; "does the diagram fit its
 *    container" is unprovable in jest and was measured in headless Chrome
 *    instead (see the header of MermaidSvgViewport.tsx for the numbers).
 *  - Selection gating through the REAL Lexical selection — not just this
 *    component's boolean prop — is proved separately in
 *    MermaidNode.selection.spec.tsx, because a green boolean here would not
 *    show that anything ever sets it.
 */
import { act, createElement, createRef } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { measureContainerWidth, MermaidResizeHandle, MermaidWidthSection } from './MermaidBlockControls'
import { MIN_MERMAID_HEIGHT_PX, MIN_MERMAID_WIDTH_PX } from './MermaidWidth'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const section = () => container.querySelector('[data-mermaid-width-section="true"]')
const field = () => container.querySelector('input[aria-label="Diagram width"]') as HTMLInputElement
const fitButton = () => container.querySelector('button[title^="Clear the stored size"]') as HTMLButtonElement
const presetButton = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement

type Handlers = { onWidthChange: jest.Mock; onHeightChange: jest.Mock }

const renderSection = (
  props: Partial<{ visible: boolean; width: string | undefined; height: number | undefined }> = {},
): Handlers => {
  const handlers: Handlers = { onWidthChange: jest.fn(), onHeightChange: jest.fn() }
  act(() => {
    root.render(
      createElement(MermaidWidthSection, {
        visible: props.visible ?? true,
        width: 'width' in props ? props.width : undefined,
        height: 'height' in props ? props.height : undefined,
        ...handlers,
      }),
    )
  })
  return handlers
}

// React installs its own `value` setter on HTMLInputElement to track the last
// value it saw, and SUPPRESSES the change event when an `input` event arrives
// with a value its tracker already holds. A plain `input.value = x` assignment
// goes through that setter, so the tracker is updated first and React's onChange
// never fires — the component's draft state would stay untouched while the DOM
// showed the new text, and a test could pass while proving nothing. Writing
// through the prototype's original setter is what makes React see a real edit.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
const type = (value: string) => {
  const input = field()
  act(() => {
    nativeInputValueSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// React delegates onBlur from the bubbling `focusout` event, not the
// non-bubbling `blur` one, so a bare `blur` dispatch would reach no handler and
// quietly prove nothing.
const blur = () => {
  act(() => {
    field().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

describe('MermaidWidthSection — on screen only while the block is selected', () => {
  it('renders nothing at all when the block is not selected', () => {
    renderSection({ visible: false })
    expect(section()).toBeNull()
    expect(container.querySelector('input')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('renders the width field and its controls when the block is selected', () => {
    renderSection({ visible: true })
    expect(section()).not.toBeNull()
    expect(field()).not.toBeNull()
    expect(fitButton()).not.toBeNull()
    for (const preset of ['25%', '50%', '75%', '100%']) {
      expect(presetButton(preset)).not.toBeNull()
    }
  })

  it('disappears again when the selection moves away', () => {
    renderSection({ visible: true })
    expect(section()).not.toBeNull()
    renderSection({ visible: false })
    expect(section()).toBeNull()
  })

  it('is excluded from printing, like the editor’s other chrome', () => {
    renderSection({ visible: true })
    expect(section()?.getAttribute('data-srn-print-exclude')).toBe('true')
  })
})

describe('MermaidWidthSection — the field reflects the stored width, not a guess', () => {
  it('shows an empty field with a "Fit" placeholder when nothing is stored', () => {
    renderSection({ width: undefined })
    expect(field().value).toBe('')
    expect(field().placeholder).toBe('Fit')
  })

  it('shows the stored width verbatim', () => {
    renderSection({ width: '50%' })
    expect(field().value).toBe('50%')
  })

  it('follows the node when the width changes from the outside (undo, a drag, a sync)', () => {
    renderSection({ width: '50%' })
    renderSection({ width: '420px' })
    expect(field().value).toBe('420px')
  })

  it('marks the matching preset as pressed, and only that one', () => {
    renderSection({ width: '50%' })
    expect(presetButton('50%').getAttribute('aria-pressed')).toBe('true')
    expect(presetButton('25%').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('MermaidWidthSection — committing a width', () => {
  it('persists a percentage on blur', () => {
    const { onWidthChange } = renderSection()
    type('60%')
    blur()
    expect(onWidthChange).toHaveBeenCalledWith('60%')
  })

  it('persists pixels on blur', () => {
    const { onWidthChange } = renderSection()
    type('420px')
    blur()
    expect(onWidthChange).toHaveBeenCalledWith('420px')
  })

  it('normalizes a bare number to pixels before persisting it', () => {
    const { onWidthChange } = renderSection()
    type('420')
    blur()
    expect(onWidthChange).toHaveBeenCalledWith('420px')
  })

  it('clamps an out-of-range value before persisting it', () => {
    const { onWidthChange } = renderSection()
    type('900%')
    blur()
    expect(onWidthChange).toHaveBeenCalledWith('100%')
  })

  it('snaps the field itself to the normalized value so what is shown is what is stored', () => {
    renderSection()
    type('420')
    blur()
    expect(field().value).toBe('420px')
  })

  it('commits on Enter as well as blur', () => {
    const { onWidthChange } = renderSection()
    type('75%')
    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onWidthChange).toHaveBeenCalledWith('75%')
  })

  it('does not persist on every keystroke — a half-typed "4" must not become 80px', () => {
    const { onWidthChange } = renderSection()
    type('4')
    expect(onWidthChange).not.toHaveBeenCalled()
    // The keystroke did reach the component's draft, so the assertion above is
    // about commit timing and not about the typing having been swallowed.
    expect(field().value).toBe('4')
  })

  it('persists a preset immediately when its button is clicked', () => {
    const { onWidthChange } = renderSection()
    act(() => presetButton('25%').click())
    expect(onWidthChange).toHaveBeenCalledWith('25%')
  })
})

describe('MermaidWidthSection — a malformed entry is reported and never applied', () => {
  it.each(['auto', 'half', '50 px', '50em', '-20%', 'calc(100% - 10px)', '50px;color:red'])(
    'refuses %s: no width is persisted',
    (bad) => {
      const { onWidthChange } = renderSection({ width: '50%' })
      type(bad)
      blur()
      expect(onWidthChange).not.toHaveBeenCalled()
    },
  )

  it('flags the field as invalid and says what is accepted', () => {
    renderSection({ width: '50%' })
    type('auto')
    blur()
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(container.textContent).toContain('Use a percentage or pixels')
  })

  it('clears the invalid state once a parseable value is entered', () => {
    const { onWidthChange } = renderSection({ width: '50%' })
    type('auto')
    blur()
    expect(field().getAttribute('aria-invalid')).toBe('true')
    type('30%')
    blur()
    expect(field().getAttribute('aria-invalid')).toBe('false')
    expect(onWidthChange).toHaveBeenCalledWith('30%')
  })

  it('Escape abandons an edit and restores the stored width', () => {
    const { onWidthChange } = renderSection({ width: '50%' })
    type('nonsense')
    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(field().value).toBe('50%')
    expect(onWidthChange).not.toHaveBeenCalled()
  })
})

describe('MermaidWidthSection — clearing returns to fitting', () => {
  it('emptying the field clears the stored width', () => {
    const { onWidthChange } = renderSection({ width: '50%' })
    type('')
    blur()
    expect(onWidthChange).toHaveBeenCalledWith(undefined)
  })

  it('a whitespace-only field also clears it', () => {
    const { onWidthChange } = renderSection({ width: '50%' })
    type('   ')
    blur()
    expect(onWidthChange).toHaveBeenCalledWith(undefined)
  })

  it('"Fit to container" clears BOTH the width and the resized height', () => {
    const { onWidthChange, onHeightChange } = renderSection({ width: '420px', height: 300 })
    act(() => fitButton().click())
    expect(onWidthChange).toHaveBeenCalledWith(undefined)
    expect(onHeightChange).toHaveBeenCalledWith(undefined)
  })

  it('"Fit to container" is disabled when nothing is stored — there is nothing to clear', () => {
    renderSection({ width: undefined, height: undefined })
    expect(fitButton().disabled).toBe(true)
  })

  it('"Fit to container" is enabled when only a height was resized', () => {
    renderSection({ width: undefined, height: 300 })
    expect(fitButton().disabled).toBe(false)
  })
})

describe('MermaidWidthSection — keeps the caret in the editor', () => {
  it('prevents default on mousedown for every button, so clicking one does not blur the editor', () => {
    renderSection({ width: '50%', height: 300 })
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      button.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
  })

  it('does NOT prevent default on the text field — an input that refuses focus cannot be typed into', () => {
    renderSection()
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    field().dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('stops a click inside the section from propagating back into the editor', () => {
    renderSection()
    const seen: Event[] = []
    // The probe must sit ABOVE React's root container: React 18 delegates click
    // at the root itself, and stopPropagation cannot stop a sibling listener on
    // the same node — only one further up.
    const probe = (event: Event) => seen.push(event)
    document.body.addEventListener('click', probe)
    try {
      field().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(seen).toHaveLength(0)
      // Control: an identical click outside the section DOES reach the probe,
      // so the assertion above is about stopPropagation and not about the
      // dispatch silently failing.
      container.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(seen).toHaveLength(1)
    } finally {
      document.body.removeEventListener('click', probe)
    }
  })
})

/**
 * jsdom reports 0 for every rect, so these stub getBoundingClientRect per
 * element — which is exactly the shape of the real hazard: a Lexical decorator's
 * own wrapper is `display: contents` and therefore genuinely has a zero-width
 * box in a real browser too.
 */
describe('measureContainerWidth — the percentage base skips boxless ancestors', () => {
  const withWidth = (width: number) => {
    const el = document.createElement('div')
    el.getBoundingClientRect = () =>
      ({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    return el
  }

  it('skips a zero-width parent — what `display: contents` produces — and uses the grandparent', () => {
    const column = withWidth(700)
    const decoratorWrapper = withWidth(0) // display: contents
    const block = withWidth(350)
    column.appendChild(decoratorWrapper)
    decoratorWrapper.appendChild(block)
    expect(measureContainerWidth(block, 123)).toBe(700)
  })

  it('uses the immediate parent when it does have a box', () => {
    const column = withWidth(700)
    const block = withWidth(350)
    column.appendChild(block)
    expect(measureContainerWidth(block, 123)).toBe(700)
  })

  it('falls back rather than returning 0 when nothing above has a box', () => {
    const outer = withWidth(0)
    const block = withWidth(0)
    outer.appendChild(block)
    expect(measureContainerWidth(block, 123)).toBe(123)
  })

  it('falls back for a detached element with no parent at all', () => {
    expect(measureContainerWidth(withWidth(350), 123)).toBe(123)
    expect(measureContainerWidth(null, 123)).toBe(123)
  })

  it('gives up after a bounded climb instead of walking the whole document', () => {
    let node = withWidth(0)
    const leaf = node
    for (let i = 0; i < 20; i++) {
      const parent = withWidth(i === 19 ? 700 : 0)
      parent.appendChild(node)
      node = parent
    }
    // The only sized ancestor is 20 levels up, well past the search depth.
    expect(measureContainerWidth(leaf, 123)).toBe(123)
  })
})

describe('MermaidResizeHandle', () => {
  const renderHandle = (active: boolean) => {
    const widthTargetRef = createRef<HTMLElement>()
    const heightTargetRef = createRef<HTMLElement>()
    const onResizeEnd = jest.fn()
    act(() => {
      root.render(
        createElement(MermaidResizeHandle, { active, widthTargetRef, heightTargetRef, unit: '%', onResizeEnd }),
      )
    })
    return { onResizeEnd }
  }

  it('renders no handle while the block is unselected', () => {
    renderHandle(false)
    expect(container.querySelector('[data-mermaid-resize-handle="true"]')).toBeNull()
  })

  it('renders a handle once the block is selected', () => {
    renderHandle(true)
    const handle = container.querySelector('[data-mermaid-resize-handle="true"]') as HTMLElement
    expect(handle).not.toBeNull()
    expect(handle.getAttribute('aria-label')).toBe('Resize diagram')
    expect(handle.style.cursor).toBe('nwse-resize')
    // touch-action:none, or a drag on a touch device scrolls the note instead.
    expect(handle.style.touchAction).toBe('none')
  })

  it('is excluded from printing', () => {
    renderHandle(true)
    expect(container.querySelector('[data-mermaid-resize-handle="true"]')?.getAttribute('data-srn-print-exclude')).toBe(
      'true',
    )
  })

  it('swallows a click so selecting the handle does not re-enter the editor', () => {
    renderHandle(true)
    const handle = container.querySelector('[data-mermaid-resize-handle="true"]') as HTMLElement
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    handle.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does nothing when there is no element to resize (no drag state is left behind)', () => {
    const { onResizeEnd } = renderHandle(true)
    const handle = container.querySelector('[data-mermaid-resize-handle="true"]') as HTMLElement
    act(() => {
      handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })
    expect(onResizeEnd).not.toHaveBeenCalled()
  })

  it('exposes the same floors the width parser clamps to, so a drag and a typed value agree', () => {
    expect(MIN_MERMAID_WIDTH_PX).toBe(80)
    expect(MIN_MERMAID_HEIGHT_PX).toBe(80)
  })
})
