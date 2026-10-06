/**
 * @jest-environment jsdom
 *
 * The shared mermaid settings controls (t118).
 *
 * The POINT of this file is that there is ONE control list, whatever arrangement
 * renders it: a control that exists in one arrangement and not the other, or that
 * writes differently in one, is the failure this guards. It asserts that
 * `mermaidSettingsControls` is the single list BOTH variants render, that the
 * variants differ only in arrangement, and that every control's write arrives on
 * the caller's callback.
 *
 * Only `panel` is mounted in the product today — t119 unmounted the chart
 * container's `bar` surface, because the user asked not to be offered the same
 * controls twice. `bar` stays covered here deliberately: it is what makes
 * restoring that surface, or a subset of it, a mount rather than a rewrite.
 *
 * jsdom has no layout engine, so nothing here measures a box.
 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import {
  MermaidSettingsPanel,
  MermaidSettingsPanelProps,
  mermaidSettingsControls,
  SUGGESTED_FIXED_MERMAID_MAX_HEIGHT_PX,
} from './MermaidSettingsPanel'
import {
  DEFAULT_MERMAID_BACKGROUND,
  DEFAULT_MERMAID_SETTINGS,
  MERMAID_BACKGROUND_LABELS,
  MERMAID_BACKGROUNDS,
  MERMAID_MAX_HEIGHT_NONE,
  MERMAID_VIEW_MODE_LABELS,
  MermaidSettings,
} from './MermaidSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root
let patches: Partial<MermaidSettings>[]
let viewModes: string[]
let widths: (string | undefined)[]
let sources: string[]

/** A two-node flowchart the Build cluster can actually model. */
const BUILDER_SOURCE = 'graph TD\n  A["Start"]\n  B["End"]\n  A --> B'

const baseProps = (overrides: Partial<MermaidSettingsPanelProps> = {}): MermaidSettingsPanelProps => ({
  variant: 'bar',
  settings: DEFAULT_MERMAID_SETTINGS,
  onSettingsChange: (patch) => patches.push(patch),
  viewMode: 'split',
  onViewModeChange: (next) => viewModes.push(next),
  code: BUILDER_SOURCE,
  onCodeChange: (next) => sources.push(next),
  width: undefined,
  onWidthChange: (next) => widths.push(next),
  height: undefined,
  onHeightChange: () => undefined,
  showWidth: true,
  ...overrides,
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  patches = []
  viewModes = []
  widths = []
  sources = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (props: MermaidSettingsPanelProps) => {
  act(() => {
    root.render(<MermaidSettingsPanel {...props} />)
  })
}

const group = (label: string) => container.querySelector(`[role="group"][aria-label="${label}"]`) as HTMLElement | null
const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null

const CONTROL_KEYS = ['source', 'builder', 'fit', 'maxHeight', 'alignment', 'theme', 'background', 'zoomPan']

/**
 * Set an input's value the way a user does. Assigning `.value` directly is seen
 * by React's own value tracker as its own write, so the subsequent `input` event
 * is dropped and `onChange` never fires — a silent false green. Going through the
 * prototype's native setter is what makes the change real.
 */
const typeInto = (field: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) {
    throw new Error('no native value setter on HTMLInputElement — the probe would be unfailable')
  }
  act(() => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the control list is the single source both arrangements render', () => {
  it('names every control exactly once, in order', () => {
    const controls = mermaidSettingsControls(baseProps())
    expect(controls.map((control) => control.key)).toEqual(CONTROL_KEYS)
    expect(new Set(controls.map((control) => control.key)).size).toBe(CONTROL_KEYS.length)
  })

  it('gives every control a caption, so neither surface shows an unlabelled knob', () => {
    for (const control of mermaidSettingsControls(baseProps())) {
      expect(control.caption.length).toBeGreaterThan(0)
    }
  })
})

describe('both variants render the same controls — only the arrangement differs', () => {
  it.each([['bar'], ['panel']] as const)('the %s variant renders every control', (variant) => {
    render(baseProps({ variant }))
    expect(container.querySelector(`[data-mermaid-settings="${variant}"]`)).not.toBeNull()
    // One interactive element per control, found by the accessible name the
    // shared cluster gives it.
    expect(group('View mode')).not.toBeNull()
    expect(group('Fit mode')).not.toBeNull()
    expect(group('Diagram alignment')).not.toBeNull()
    expect(byLabel('Maximum diagram height')).not.toBeNull()
    expect(byLabel('Diagram theme')).not.toBeNull()
    expect(byLabel('Diagram background')).not.toBeNull()
    expect(byLabel('Pan and zoom over the diagram')).not.toBeNull()
    // The BUILD cluster — the one that writes the diagram's source rather than
    // its appearance. It is the control the user reported as missing.
    expect(byLabel('Add a diagram node')).not.toBeNull()
    expect(byLabel('Add a diagram link')).not.toBeNull()
    expect(byLabel('Diagram flow direction')).not.toBeNull()
    // The width strip is delegated, not reimplemented.
    expect(container.querySelector('[data-mermaid-width-section="true"]')).not.toBeNull()
  })

  it('renders the same number of interactive controls in both variants', () => {
    render(baseProps({ variant: 'bar' }))
    const bar = container.querySelectorAll('button, select, input').length
    act(() => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render(baseProps({ variant: 'panel' }))
    const panel = container.querySelectorAll('button, select, input').length
    expect(bar).toBe(panel)
    expect(bar).toBeGreaterThan(10)
  })

  it('hides only the width strip when the mount point gates it', () => {
    render(baseProps({ showWidth: false }))
    expect(container.querySelector('[data-mermaid-width-section="true"]')).toBeNull()
    // Everything else is still there.
    expect(group('Fit mode')).not.toBeNull()
    expect(byLabel('Diagram theme')).not.toBeNull()
  })
})

describe('every control writes, and writes only its own field', () => {
  it('the fit mode', () => {
    render(baseProps())
    const button = Array.from(group('Fit mode')!.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Actual size',
    ) as HTMLButtonElement
    act(() => button.click())
    expect(patches).toEqual([{ fitMode: 'actual' }])
  })

  it('the alignment', () => {
    render(baseProps())
    const button = group('Diagram alignment')!.querySelector('[aria-label="Align right"]') as HTMLButtonElement
    act(() => button.click())
    expect(patches).toEqual([{ alignment: 'right' }])
  })

  it('the theme', () => {
    render(baseProps())
    const select = byLabel('Diagram theme') as HTMLSelectElement
    act(() => {
      select.value = 'forest'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(patches).toEqual([{ themeMode: 'forest' }])
  })

  /**
   * The background control is a SELECT over `MERMAID_BACKGROUNDS`, not the
   * two-state toggle it used to be. The toggle flipped `themed`/`transparent`
   * and so could never return to a third value: once `auto` became the default,
   * the control could not express the default. This drives every value FROM
   * every value and asserts the patch each move emits — the full matrix, since a
   * cycle control would satisfy any single round trip and still fail this.
   */
  it('the background, reaching every value from every value', () => {
    for (const from of MERMAID_BACKGROUNDS) {
      for (const to of MERMAID_BACKGROUNDS) {
        if (from === to) {
          continue
        }
        patches = []
        render(baseProps({ settings: { ...DEFAULT_MERMAID_SETTINGS, background: from } }))
        const select = byLabel('Diagram background') as HTMLSelectElement
        // The control shows where it is starting from, so a user can tell.
        expect([from, to, select.value]).toEqual([from, to, from])
        act(() => {
          select.value = to
          select.dispatchEvent(new Event('change', { bubbles: true }))
        })
        expect([from, to, patches]).toEqual([from, to, [{ background: to }]])
      }
    }
  })

  it('offers exactly the background vocabulary MermaidSettings declares', () => {
    render(baseProps())
    const select = byLabel('Diagram background') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.value)).toEqual([...MERMAID_BACKGROUNDS])
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(
      MERMAID_BACKGROUNDS.map((value) => MERMAID_BACKGROUND_LABELS[value]),
    )
    // The default is one of the offered values — i.e. expressible by the control.
    expect(Array.from(select.options).map((option) => option.value)).toContain(DEFAULT_MERMAID_BACKGROUND)
  })

  it('the pan/zoom toggle, both ways', () => {
    render(baseProps())
    act(() => (byLabel('Pan and zoom over the diagram') as HTMLButtonElement).click())
    expect(patches).toEqual([{ zoomPan: false }])
    patches = []
    render(baseProps({ settings: { ...DEFAULT_MERMAID_SETTINGS, zoomPan: false } }))
    act(() => (byLabel('Pan and zoom over the diagram') as HTMLButtonElement).click())
    expect(patches).toEqual([{ zoomPan: true }])
  })

  it('the view mode', () => {
    render(baseProps())
    // Found by the LABEL the shared vocabulary gives the mode, not by the stored
    // value: the control prints MERMAID_VIEW_MODE_LABELS, so hardcoding the raw
    // value here would assert the label away the next time one is reworded.
    const button = Array.from(group('View mode')!.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === MERMAID_VIEW_MODE_LABELS.code,
    ) as HTMLButtonElement
    act(() => button.click())
    expect(viewModes).toEqual(['code'])
    expect(patches).toEqual([])
  })

  it('the width presets, through the one existing width implementation', () => {
    render(baseProps())
    const button = Array.from(container.querySelectorAll('[aria-label="Width presets"] button')).find(
      (candidate) => candidate.textContent === '50%',
    ) as HTMLButtonElement
    act(() => button.click())
    expect(widths).toEqual(['50%'])
  })
})

describe('the maximum height is the configurable cap, in three expressible states', () => {
  it('reads as "follow window" when nothing is stored', () => {
    render(baseProps())
    expect((byLabel('Maximum diagram height') as HTMLSelectElement).value).toBe('window')
    expect(byLabel('Maximum diagram height in pixels')).toBeNull()
  })

  it('writes the no-limit sentinel, which is what makes a width-fit span the container', () => {
    render(baseProps())
    const select = byLabel('Maximum diagram height') as HTMLSelectElement
    act(() => {
      select.value = 'none'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(patches).toEqual([{ maxHeight: MERMAID_MAX_HEIGHT_NONE }])
  })

  it('seeds a fixed value and then takes an explicit number', () => {
    render(baseProps())
    const select = byLabel('Maximum diagram height') as HTMLSelectElement
    act(() => {
      select.value = 'fixed'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(patches).toEqual([{ maxHeight: SUGGESTED_FIXED_MERMAID_MAX_HEIGHT_PX }])

    patches = []
    render(baseProps({ settings: { ...DEFAULT_MERMAID_SETTINGS, maxHeight: 640 } }))
    const field = byLabel('Maximum diagram height in pixels') as HTMLInputElement
    expect(field).not.toBeNull()
    expect(field.value).toBe('640')
    expect((byLabel('Maximum diagram height') as HTMLSelectElement).value).toBe('fixed')
    typeInto(field, '900')
    expect(patches).toEqual([{ maxHeight: 900 }])
  })

  it('ignores an unusable typed value rather than writing it', () => {
    render(baseProps({ settings: { ...DEFAULT_MERMAID_SETTINGS, maxHeight: 640 } }))
    const field = byLabel('Maximum diagram height in pixels') as HTMLInputElement
    typeInto(field, '')
    expect(patches).toEqual([])
  })

  it('shows the no-limit state as selected when it is stored', () => {
    render(baseProps({ settings: { ...DEFAULT_MERMAID_SETTINGS, maxHeight: MERMAID_MAX_HEIGHT_NONE } }))
    expect((byLabel('Maximum diagram height') as HTMLSelectElement).value).toBe('none')
  })
})

describe('no control renders its icon name as text (the mapping-miss trap)', () => {
  it('draws real svg glyphs for the alignment buttons', () => {
    render(baseProps())
    const buttons = Array.from(group('Diagram alignment')!.querySelectorAll('button'))
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      expect(button.querySelector('svg')).not.toBeNull()
      expect(button.querySelector('label')).toBeNull()
      expect(button.textContent ?? '').toBe('')
    }
  })
})
