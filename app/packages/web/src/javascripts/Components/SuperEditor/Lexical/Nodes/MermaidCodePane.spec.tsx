/**
 * @jest-environment jsdom
 *
 * Render contract for the mermaid source pane.
 *
 * WHAT jsdom CAN AND CANNOT PROVE HERE, stated up front so nothing below is
 * read as more than it is. jsdom has NO layout engine: `getComputedStyle`
 * returns only what was declared inline, every rect is 0x0, and no stylesheet
 * in this repo is even loaded. So caret alignment, scroll synchronisation, wrap
 * behaviour and token COLOUR are all unprovable here and are measured in
 * headless Chrome instead (the numbers are in `MermaidCodePane.tsx`'s header and
 * the commit message).
 *
 * What this file proves is everything that DECIDES those: that the two layers
 * exist, that both carry the one shared geometry class, that the underlay's text
 * is character-for-character the textarea's value, that the spans carry the
 * token classes the stylesheet paints, that the underlay is inert and hidden
 * from assistive technology, and that turning the preference off leaves a plain
 * textarea and no underlay at all.
 *
 * It is deliberately NOT scored on the absence of an error. Every assertion
 * names a concrete span and a concrete class, so a pane that rendered an empty
 * `<pre>` — which looks identical to highlighting being switched off — fails
 * them. `the guard on the guard` at the end is the test that fails if the token
 * spans stop being emitted.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import MermaidCodePane, {
  MERMAID_CODE_INPUT_ATTRIBUTE,
  MERMAID_CODE_LAYER_CLASS,
  MERMAID_CODE_LINE_CLASS,
  MERMAID_CODE_PANE_ATTRIBUTE,
  MERMAID_CODE_UNDERLAY_ATTRIBUTE,
} from './MermaidCodePane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
  unobserve(): void {}
  disconnect(): void {}
}

const SOURCE = [
  'flowchart LR',
  '  %% the happy path',
  '  A[Start] --> B{Ready?}',
  '  B -->|yes| C((Done))',
  '  classDef hot fill:#f00',
].join('\n')

let container: HTMLElement
let root: Root

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function render(props: { value: string; highlight: boolean; onChange?: (value: string) => void }): void {
  act(() => {
    root.render(
      createElement(MermaidCodePane, {
        value: props.value,
        highlight: props.highlight,
        onChange: props.onChange ?? (() => undefined),
      }),
    )
  })
}

/**
 * Type into a CONTROLLED textarea. React tracks the last value it rendered on
 * the node itself, so assigning `.value` directly makes React believe nothing
 * changed and `onChange` never fires. Going through the prototype's setter is
 * what updates that tracker — the same helper
 * `FileDescriptionEditor.spec.tsx` and `PlainEditor.security.spec.tsx` use.
 */
function type(textarea: HTMLTextAreaElement, next: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) {
    throw new Error('no native value setter')
  }
  act(() => {
    setter.call(textarea, next)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const pane = (): HTMLElement => {
  const element = container.querySelector(`[${MERMAID_CODE_PANE_ATTRIBUTE}]`)
  if (!element) {
    throw new Error('no pane rendered')
  }
  return element as HTMLElement
}
const underlay = (): HTMLElement | null =>
  container.querySelector(`[${MERMAID_CODE_UNDERLAY_ATTRIBUTE}]`) as HTMLElement | null
/**
 * The underlay's text, reassembled.
 *
 * The underlay holds ONE BLOCK PER LINE and no newline characters, so
 * `textContent` is the lines run together and is not the thing to compare. The
 * equivalent — and stronger — check is that the line blocks joined with
 * newlines reproduce the textarea's value exactly, which is what every
 * alignment claim rests on. See MermaidCodeLine for why the structure is
 * blocks.
 */
const underlayText = (): string =>
  Array.from(underlay()?.querySelectorAll(`.${MERMAID_CODE_LINE_CLASS}`) ?? [])
    .map((line) => line.textContent ?? '')
    .join('\n')

const lineBlocks = (): Element[] => Array.from(underlay()?.querySelectorAll(`.${MERMAID_CODE_LINE_CLASS}`) ?? [])

const input = (): HTMLTextAreaElement => {
  const element = container.querySelector(`[${MERMAID_CODE_INPUT_ATTRIBUTE}]`)
  if (!element) {
    throw new Error('no textarea rendered')
  }
  return element as HTMLTextAreaElement
}

describe('with highlighting on', () => {
  beforeEach(() => {
    render({ value: SOURCE, highlight: true })
  })

  it('renders both layers', () => {
    expect(underlay()).not.toBeNull()
    expect(underlay()?.tagName).toBe('PRE')
    expect(input().tagName).toBe('TEXTAREA')
  })

  it('gives BOTH layers the one shared geometry class', () => {
    // The whole technique rests on this. If one layer loses the class, the
    // editor root styles the `<pre>` and the UA styles the `<textarea>`, and
    // they wrap and advance differently. See the rule in `mermaid-code.scss`.
    expect(underlay()?.classList.contains(MERMAID_CODE_LAYER_CLASS)).toBe(true)
    expect(input().classList.contains(MERMAID_CODE_LAYER_CLASS)).toBe(true)
  })

  it('makes the textarea the transparent-text variant', () => {
    expect(input().classList.contains('MermaidCode__input--highlighted')).toBe(true)
  })

  it('puts the underlay BEHIND the textarea in document order', () => {
    // The stylesheet's `z-index` does the real work, but a `<pre>` emitted
    // after the textarea would also need a different stacking rule, so the
    // order is pinned here rather than assumed.
    const children = Array.from(pane().children)
    expect(children.indexOf(underlay() as Element)).toBeLessThan(children.indexOf(input()))
  })

  it("reproduces the textarea's value character-for-character", () => {
    // THE alignment contract jsdom can see. A dropped or duplicated character
    // shifts every following glyph in the underlay.
    expect(underlayText()).toBe(SOURCE)
    expect(input().value).toBe(SOURCE)
  })

  it('emits one line block per source line and no newline characters at all', () => {
    // The structure the per-keystroke cost and the trailing-line correctness
    // both depend on. A newline character anywhere in the underlay would add a
    // row that the textarea does not have.
    expect(lineBlocks()).toHaveLength(SOURCE.split('\n').length)
    expect(underlay()?.textContent).not.toContain('\n')
  })

  it('stays one block per line across re-renders', () => {
    render({ value: SOURCE, highlight: true })
    render({ value: SOURCE, highlight: true })
    expect(lineBlocks()).toHaveLength(SOURCE.split('\n').length)
    expect(underlayText()).toBe(SOURCE)
  })

  it('emits spans carrying the token classes the stylesheet paints', () => {
    const classes = Array.from(underlay()?.querySelectorAll('span') ?? []).map((span) => span.className)
    expect(classes).toContain(MERMAID_CODE_LINE_CLASS)
    expect(classes).toContain('MermaidCode__keyword')
    expect(classes).toContain('MermaidCode__comment')
    expect(classes).toContain('MermaidCode__operator')
    expect(classes).toContain('MermaidCode__punctuation')
    expect(classes).toContain('MermaidCode__string')
  })

  it('puts the right text in the right span', () => {
    const textOf = (className: string): string[] =>
      Array.from(underlay()?.querySelectorAll(`span.${className}`) ?? []).map((span) => span.textContent ?? '')
    expect(textOf('MermaidCode__keyword')).toContain('flowchart')
    expect(textOf('MermaidCode__keyword')).toContain('LR')
    expect(textOf('MermaidCode__keyword')).toContain('classDef')
    expect(textOf('MermaidCode__comment')).toEqual(['%% the happy path'])
    expect(textOf('MermaidCode__operator')).toEqual(['-->', '-->'])
    expect(textOf('MermaidCode__string')).toEqual(['yes'])
  })

  it('hides the underlay from assistive technology and from the pointer', () => {
    expect(underlay()?.getAttribute('aria-hidden')).toBe('true')
    // `pointer-events` and `user-select` live in the stylesheet, which jsdom
    // does not load; the class that carries them is what can be asserted here.
    expect(underlay()?.classList.contains('MermaidCode__underlay')).toBe(true)
  })

  it('keeps the textarea the accessible, editable element', () => {
    expect(input().getAttribute('aria-label')).toBe('Mermaid source')
    expect(input().hasAttribute('aria-hidden')).toBe(false)
    expect(input().hasAttribute('readonly')).toBe(false)
    expect(input().hasAttribute('disabled')).toBe(false)
  })

  it('keeps every autocorrect-style affordance off, as the bare textarea had', () => {
    const textarea = input()
    expect(textarea.getAttribute('spellcheck')).toBe('false')
    expect(textarea.getAttribute('autocorrect')).toBe('off')
    expect(textarea.getAttribute('autocapitalize')).toBe('off')
    expect(textarea.getAttribute('autocomplete')).toBe('off')
    // Grammarly injects its own overlay into a textarea and would fight ours.
    expect(textarea.getAttribute('data-gramm')).toBe('false')
  })

  it('auto-grows with the content, as the bare textarea did', () => {
    expect(input().rows).toBe(Math.max(6, SOURCE.split('\n').length + 1))
    const long = Array.from({ length: 40 }, (_unused, index) => `  A${index} --> B${index}`).join('\n')
    render({ value: `flowchart LR\n${long}`, highlight: true })
    expect(input().rows).toBe(42)
  })

  it('reports every edit through onChange, unchanged', () => {
    const onChange = jest.fn()
    render({ value: SOURCE, highlight: true, onChange })
    type(input(), 'graph TD')
    expect(onChange).toHaveBeenCalledWith('graph TD')
  })

  it('tracks the value it is given', () => {
    render({ value: 'sequenceDiagram\n  A->>B: hi', highlight: true })
    expect(input().value).toBe('sequenceDiagram\n  A->>B: hi')
    expect(underlayText()).toBe('sequenceDiagram\n  A->>B: hi')
    const keywords = Array.from(underlay()?.querySelectorAll('span.MermaidCode__keyword') ?? []).map(
      (span) => span.textContent,
    )
    expect(keywords).toContain('sequenceDiagram')
  })

  it('renders markup in the source as TEXT and never as elements', () => {
    // The pane builds React elements, never an HTML string, so there is no
    // injection sink to sanitize. This asserts that, rather than trusting it.
    const hostile = 'flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B\n  %% <script>alert(2)</script>'
    render({ value: hostile, highlight: true })
    expect(underlay()?.querySelector('img')).toBeNull()
    expect(underlay()?.querySelector('script')).toBeNull()
    expect(underlayText()).toBe(hostile)
  })

  it('survives an empty source', () => {
    render({ value: '', highlight: true })
    expect(lineBlocks()).toHaveLength(1)
    expect(underlayText()).toBe('')
    expect(input().value).toBe('')
    expect(input().rows).toBe(6)
  })

  it('survives a source that is only newlines', () => {
    render({ value: '\n\n\n', highlight: true })
    expect(lineBlocks()).toHaveLength(4)
    expect(underlayText()).toBe('\n\n\n')
  })

  it('gives a trailing newline its own empty block, as the textarea gives it a row', () => {
    render({ value: 'flowchart LR\n  A --> B\n', highlight: true })
    expect(lineBlocks()).toHaveLength(3)
    expect(lineBlocks()[2].textContent).toBe('')
    expect(underlayText()).toBe('flowchart LR\n  A --> B\n')
  })

  it('synchronises the underlay scroll offset from the textarea', () => {
    const textarea = input()
    const pre = underlay() as HTMLElement
    // jsdom has no layout, so `scrollTop` is a plain settable property here;
    // what is being asserted is that the handler copies it, not that the
    // browser scrolls. The real alignment is measured in Chrome.
    textarea.scrollTop = 120
    textarea.scrollLeft = 7
    act(() => {
      textarea.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(pre.scrollTop).toBe(120)
    expect(pre.scrollLeft).toBe(7)
  })
})

describe('with highlighting off', () => {
  beforeEach(() => {
    render({ value: SOURCE, highlight: false })
  })

  it('renders NO underlay at all', () => {
    expect(underlay()).toBeNull()
    expect(pane().querySelectorAll('pre')).toHaveLength(0)
  })

  it('leaves the textarea opaque', () => {
    expect(input().classList.contains('MermaidCode__input--highlighted')).toBe(false)
  })

  it('still carries the geometry class, so the pane does not move', () => {
    expect(input().classList.contains(MERMAID_CODE_LAYER_CLASS)).toBe(true)
  })

  it('still edits', () => {
    const onChange = jest.fn()
    render({ value: SOURCE, highlight: false, onChange })
    type(input(), 'pie showData')
    expect(onChange).toHaveBeenCalledWith('pie showData')
  })
})

describe('toggling the preference live', () => {
  it('adds and removes the underlay with no remount and no value loss', () => {
    render({ value: SOURCE, highlight: false })
    const before = input()
    expect(underlay()).toBeNull()

    render({ value: SOURCE, highlight: true })
    expect(underlay()).not.toBeNull()
    // THE live-toggle contract: the same textarea element, so the caret,
    // selection and native undo stack all survive the switch.
    expect(input()).toBe(before)
    expect(input().value).toBe(SOURCE)

    render({ value: SOURCE, highlight: false })
    expect(underlay()).toBeNull()
    expect(input()).toBe(before)
    expect(input().value).toBe(SOURCE)
  })
})

describe('the guard on the guard', () => {
  it('fails if the pane stops emitting token spans', () => {
    // An empty underlay renders exactly like highlighting being off, so this is
    // the assertion that distinguishes "working" from "silently inert". It is
    // stated as a count rather than a presence check so a pane that emitted one
    // unclassified span would not satisfy it either.
    render({ value: SOURCE, highlight: true })
    const spans = Array.from(underlay()?.querySelectorAll('span[class^="MermaidCode__"]') ?? []).filter(
      (span) => span.className !== MERMAID_CODE_LINE_CLASS,
    )
    expect(spans.length).toBeGreaterThan(10)
    expect(new Set(spans.map((span) => span.className)).size).toBeGreaterThanOrEqual(5)
  })
})
