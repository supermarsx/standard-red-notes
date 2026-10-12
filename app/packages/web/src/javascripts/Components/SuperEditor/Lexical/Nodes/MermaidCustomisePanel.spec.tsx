/**
 * @jest-environment jsdom
 *
 * The Customise panel, mounted for real.
 *
 * What is pinned here is what a person does and what then leaves the panel:
 * each control hands on exactly the text its key belongs in; a control mermaid
 * has no option for says so instead of rendering; a refused change shows its
 * reason and hands on nothing; and a slider being dragged re-renders nobody but
 * itself and writes once.
 *
 * The harness plays the part of the editor: it holds the diagram's text and the
 * block's theme, and feeds back whatever the panel hands it — so "the panel then
 * shows what was chosen" is tested through the same round trip the real toolbar
 * makes. jsdom has no layout, so nothing here is evidence of how it looks.
 */
import { act, useEffect, useState } from 'react'
import { createRoot, Root } from 'react-dom/client'
import {
  MermaidCustomiseButton,
  MermaidCustomisePanel,
  MermaidEffectiveThemeSelect,
  MERMAID_SLIDER_COMMIT_DELAY_MS,
  MermaidStyleEdit,
} from './MermaidCustomisePanel'
import { MERMAID_LIBRARY_THEME_LABELS } from './MermaidConfigCatalog'
import { MERMAID_SAMPLE_DIAGRAMS } from './MermaidCustomise.fixtures'
import { MERMAID_LIBRARY_THEMES, MermaidThemeMode } from './MermaidSettings'
import { MermaidConfigRefusal } from './MermaidSourceConfig'
import { MERMAID_STYLE_PRESETS } from './MermaidStylePresets'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FLOW = MERMAID_SAMPLE_DIAGRAMS.flowchart
const fm = (yaml: string, body: string) => `---\n${yaml}\n---\n${body}`

let container: HTMLElement
let root: Root
/** Every edit the panel handed on, in order. */
let edits: MermaidStyleEdit[]
/** How many times the component ABOVE the panel rendered. */
let hostRenders: number
/** What the harness currently holds — the "editor" side of the round trip. */
let held: MermaidStyleEdit

const Host = ({ initial, notice }: { initial: MermaidStyleEdit; notice?: MermaidConfigRefusal }) => {
  const [state, setState] = useState(initial)
  // An effect with no dependency list runs after every render of THIS component
  // and not when a child re-renders by itself — which is the distinction the
  // slider tests below turn on.
  useEffect(() => {
    hostRenders++
    held = state
  })
  return (
    <MermaidCustomisePanel
      code={state.code}
      themeMode={state.themeMode}
      notice={notice}
      onApply={(edit) => {
        edits.push(edit)
        setState(edit)
      }}
    />
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  edits = []
  hostRenders = 0
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  jest.useRealTimers()
})

const mount = (code: string, themeMode: MermaidThemeMode = 'app', notice?: MermaidConfigRefusal) => {
  act(() => {
    root.render(<Host initial={{ code, themeMode }} notice={notice} />)
  })
}

const panel = () => container.querySelector('[data-mermaid-customise="panel"]') as HTMLElement
const row = (label: string) => container.querySelector(`[data-mermaid-customise-row="${label}"]`) as HTMLElement | null
const preset = (id: string) => container.querySelector(`[data-mermaid-preset="${id}"]`) as HTMLButtonElement
const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null
const alertBox = () => container.querySelector('[role="alert"]') as HTMLElement | null
const standing = (kind: string) =>
  container.querySelector(`[data-mermaid-customise-standing="${kind}"]`) as HTMLElement | null
const resetButton = () => container.querySelector('[data-mermaid-customise-reset="true"]') as HTMLButtonElement
const buttonIn = (parent: HTMLElement | null, text: string) =>
  Array.from(parent?.querySelectorAll('button') ?? []).find((button) => button.textContent === text) as
    HTMLButtonElement | undefined
const pressedIn = (parent: HTMLElement | null) =>
  Array.from(parent?.querySelectorAll('button[aria-pressed="true"]') ?? []).map((button) => button.textContent)

const click = (element: HTMLElement | undefined | null) => {
  if (!element) {
    throw new Error('nothing to click')
  }
  act(() => {
    element.click()
  })
}

/**
 * Drive a real <select> the way React's onChange sees it — the native value
 * setter plus a bubbling change event. `select.value = x` alone sets the DOM
 * property without notifying React, so a control that writes nothing would pass.
 */
const choose = (select: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  if (!setter) {
    throw new Error('no native value setter on HTMLSelectElement')
  }
  act(() => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** One tick of a drag: the value moves and the browser fires `input`, nothing more. */
const slideTo = (range: HTMLInputElement, value: number) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) {
    throw new Error('no native value setter on HTMLInputElement')
  }
  act(() => {
    setter.call(range, String(value))
    range.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The end of a movement: a released drag, or one key press. */
const release = (range: HTMLInputElement) => {
  act(() => {
    range.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const themeSelect = () => byLabel('Diagram theme') as HTMLSelectElement
const sizeSlider = () => byLabel('Text size, fine') as HTMLInputElement
const spacingSlider = () => byLabel('Spacing, fine') as HTMLInputElement

describe('what the panel shows for an untouched flowchart', () => {
  beforeEach(() => mount(FLOW))

  it('says what kind of diagram it is looking at', () => {
    expect(panel().textContent).toContain('a flowchart')
    expect(container.querySelector('[data-mermaid-customise-kind]')?.getAttribute('data-mermaid-customise-kind')).toBe(
      'flowchart',
    )
  })

  it('offers the six presets, with App the one in force', () => {
    const buttons = Array.from(container.querySelectorAll('[data-mermaid-preset]')) as HTMLButtonElement[]
    expect(buttons.map((button) => button.textContent)).toEqual(MERMAID_STYLE_PRESETS.map((entry) => entry.label))
    expect(
      buttons.filter((button) => button.getAttribute('aria-pressed') === 'true').map((b) => b.textContent),
    ).toEqual(['App'])
    expect(buttons.every((button) => !button.disabled)).toBe(true)
    // Each says what it does before it is pressed.
    for (const button of buttons) {
      expect((button.getAttribute('title') ?? '').length).toBeGreaterThan(10)
    }
  })

  it('offers the app theme and all eleven of mermaid’s, by name', () => {
    const options = Array.from(themeSelect().options)
    expect(options.map((option) => option.value)).toEqual(['app', ...MERMAID_LIBRARY_THEMES])
    expect(options.map((option) => option.textContent)).toEqual([
      'App theme',
      ...MERMAID_LIBRARY_THEMES.map((theme) => MERMAID_LIBRARY_THEME_LABELS[theme]),
    ])
    expect(options).toHaveLength(12)
    expect(themeSelect().value).toBe('app')
    expect(row('Theme')?.textContent).toContain('Follows the app’s light or dark theme.')
  })

  it('has every control at mermaid’s own default', () => {
    expect(pressedIn(byLabel('Diagram look'))).toEqual(['Classic'])
    expect(pressedIn(byLabel('Text size'))).toEqual(['100%'])
    expect(pressedIn(byLabel('Spacing'))).toEqual(['Normal'])
    expect((byLabel('Line style') as HTMLSelectElement).value).toBe('basis')
    expect(sizeSlider().value).toBe('16')
    expect(spacingSlider().value).toBe('100')
    expect(row('Text size')?.querySelector('output')?.textContent).toBe('100% · 16px')
  })

  it('has nothing to reset, and no notice to show', () => {
    expect(resetButton().disabled).toBe(true)
    expect(alertBox()).toBeNull()
    expect(container.querySelector('[data-mermaid-customise-standing]')).toBeNull()
  })

  it('writes nothing by being opened', () => {
    expect(edits).toEqual([])
  })
})

describe('each control hands on exactly its own lines', () => {
  it('a preset', () => {
    mount(FLOW)
    click(preset('presentation'))
    expect(edits).toEqual([
      {
        code: fm(
          'config:\n  themeVariables:\n    fontSize: "20px"\n  flowchart:\n    nodeSpacing: 80\n    rankSpacing: 80',
          FLOW,
        ),
        themeMode: 'app',
      },
    ])
    // And the panel then shows that preset, and the controls it is made of.
    expect(preset('presentation').getAttribute('aria-pressed')).toBe('true')
    expect(preset('app').getAttribute('aria-pressed')).toBe('false')
    expect(pressedIn(byLabel('Text size'))).toEqual(['125%'])
    expect(pressedIn(byLabel('Spacing'))).toEqual(['Spacious'])
    expect(sizeSlider().value).toBe('20')
    expect(resetButton().disabled).toBe(false)
  })

  it('a theme: into the text, with the block given the matching stored value', () => {
    mount(FLOW)
    choose(themeSelect(), 'forest')
    expect(edits).toEqual([{ code: fm('config:\n  theme: forest', FLOW), themeMode: 'forest' }])
    expect(themeSelect().value).toBe('forest')
    expect(row('Theme')?.textContent).toContain('Written in the diagram’s text, line 3.')
  })

  it('one of the six newer themes: the block is given a theme of the same polarity', () => {
    mount(FLOW)
    choose(themeSelect(), 'neo-dark')
    expect(edits).toEqual([{ code: fm('config:\n  theme: neo-dark', FLOW), themeMode: 'dark' }])
    expect(themeSelect().value).toBe('neo-dark')
  })

  it('the hand-drawn look, with its fixed seed, and Redraw', () => {
    mount(FLOW)
    expect(buttonIn(row('Look'), 'Redraw')).toBeUndefined()
    click(buttonIn(byLabel('Diagram look'), 'Hand-drawn'))
    expect(edits[0]).toEqual({ code: fm('config:\n  look: handDrawn\n  handDrawnSeed: 7', FLOW), themeMode: 'app' })
    expect(pressedIn(byLabel('Diagram look'))).toEqual(['Hand-drawn'])
    expect(preset('sketch').getAttribute('aria-pressed')).toBe('true')

    click(buttonIn(row('Look'), 'Redraw'))
    expect(edits[1].code).toBe(fm('config:\n  look: handDrawn\n  handDrawnSeed: 8', FLOW))
    // A redrawn sketch is still the Sketch preset.
    expect(preset('sketch').getAttribute('aria-pressed')).toBe('true')

    click(buttonIn(byLabel('Diagram look'), 'Classic'))
    expect(edits[2]).toEqual({ code: FLOW, themeMode: 'app' })
  })

  it('a text size', () => {
    mount(FLOW)
    click(buttonIn(byLabel('Text size'), '125%'))
    expect(edits).toEqual([{ code: fm('config:\n  themeVariables:\n    fontSize: "20px"', FLOW), themeMode: 'app' }])
    expect(row('Text size')?.querySelector('output')?.textContent).toBe('125% · 20px')
  })

  it('a spacing level', () => {
    mount(FLOW)
    click(buttonIn(byLabel('Spacing'), 'Compact'))
    expect(edits).toEqual([
      { code: fm('config:\n  flowchart:\n    nodeSpacing: 30\n    rankSpacing: 30', FLOW), themeMode: 'app' },
    ])
  })

  it('a line style', () => {
    mount(FLOW)
    choose(byLabel('Line style') as HTMLSelectElement, 'linear')
    expect(edits).toEqual([{ code: fm('config:\n  flowchart:\n    curve: linear', FLOW), themeMode: 'app' }])
    expect((byLabel('Line style') as HTMLSelectElement).value).toBe('linear')
  })

  it('hands on nothing when the choice is the one already in force', () => {
    mount(FLOW)
    click(preset('app'))
    click(buttonIn(byLabel('Text size'), '100%'))
    click(buttonIn(byLabel('Spacing'), 'Normal'))
    click(buttonIn(byLabel('Diagram look'), 'Classic'))
    choose(themeSelect(), 'app')
    expect(edits.filter((edit) => edit.code !== FLOW || edit.themeMode !== 'app')).toEqual([])
  })

  it('leaves the block’s own theme alone for everything but a theme choice', () => {
    mount(FLOW, 'forest')
    click(buttonIn(byLabel('Text size'), '125%'))
    click(buttonIn(byLabel('Spacing'), 'Compact'))
    choose(byLabel('Line style') as HTMLSelectElement, 'step')
    expect(edits.map((edit) => edit.themeMode)).toEqual(['forest', 'forest', 'forest'])
  })
})

describe('reset', () => {
  it('gives the text back byte for byte, after any number of changes', () => {
    const original = fm('title: Plan\nconfig:\n  layout: dagre', FLOW)
    mount(original)
    click(preset('presentation'))
    click(buttonIn(byLabel('Diagram look'), 'Hand-drawn'))
    choose(themeSelect(), 'neo')
    choose(byLabel('Line style') as HTMLSelectElement, 'step')
    expect(held.code).not.toBe(original)
    expect(held.themeMode).toBe('default')

    click(resetButton())
    expect(held).toEqual({ code: original, themeMode: 'app' })
    expect(resetButton().disabled).toBe(true)
    expect(preset('app').getAttribute('aria-pressed')).toBe('true')
  })

  it('unpins a block pinned to a theme the old way, which has nothing in its text', () => {
    mount(FLOW, 'forest')
    expect(themeSelect().value).toBe('forest')
    expect(row('Theme')?.textContent).toContain('Pinned on this block')
    expect(resetButton().disabled).toBe(false)
    click(resetButton())
    expect(edits).toEqual([{ code: FLOW, themeMode: 'app' }])
    expect(themeSelect().value).toBe('app')
  })
})

describe('a kind of diagram mermaid has fewer options for', () => {
  it('says why there is no look and no line style for a sequence diagram, instead of offering them', () => {
    mount(MERMAID_SAMPLE_DIAGRAMS.sequence)
    expect(panel().textContent).toContain('a sequence diagram')
    expect(byLabel('Diagram look')).toBeNull()
    expect(byLabel('Line style')).toBeNull()
    expect(row('Look')?.textContent).toContain('Mermaid draws a sequence diagram the same in either look.')
    expect(row('Line style')?.textContent).toContain('Mermaid has no line style for a sequence diagram.')
    expect(row('Look')?.getAttribute('data-mermaid-customise-unavailable')).toBe('true')
    // What it does have still works, with the keys a sequence diagram reads.
    click(buttonIn(byLabel('Text size'), '125%'))
    click(buttonIn(byLabel('Spacing'), 'Spacious'))
    expect(held.code).toBe(
      fm(
        'config:\n  fontSize: 20\n  sequence:\n    actorMargin: 80\n    boxMargin: 16',
        MERMAID_SAMPLE_DIAGRAMS.sequence,
      ),
    )
  })

  it('disables the Sketch preset there and puts the reason on the page, not only in a tooltip', () => {
    mount(MERMAID_SAMPLE_DIAGRAMS.sequence)
    expect(preset('sketch').disabled).toBe(true)
    expect(container.querySelector('[data-mermaid-preset-unavailable="sketch"]')?.textContent).toBe(
      'Sketch changes nothing for a sequence diagram: mermaid has none of its options for that kind.',
    )
    click(preset('sketch'))
    expect(edits).toEqual([])
    // The other five are offered.
    expect(
      (Array.from(container.querySelectorAll('[data-mermaid-preset]')) as HTMLButtonElement[]).filter(
        (b) => !b.disabled,
      ),
    ).toHaveLength(5)
  })

  it('shows a pie chart its three text sizes as one, and no spacing', () => {
    mount(MERMAID_SAMPLE_DIAGRAMS.pie)
    expect(row('Spacing')?.textContent).toContain('Mermaid has no spacing option for a pie chart.')
    expect(byLabel('Spacing, fine')).toBeNull()
    // 100% of a pie's own default, which is 17px and not 16.
    expect(row('Text size')?.querySelector('output')?.textContent).toBe('100% · 17px')
    click(preset('presentation'))
    expect(row('Text size')?.querySelector('output')?.textContent).toBe('125% · 21.25px')
    expect(preset('presentation').getAttribute('aria-pressed')).toBe('true')
  })

  it('still offers theme and text size for a kind it has no name for', () => {
    mount(MERMAID_SAMPLE_DIAGRAMS.unknown)
    expect(panel().textContent).toContain('this kind of diagram')
    expect(themeSelect()).not.toBeNull()
    expect(sizeSlider()).not.toBeNull()
    expect(row('Spacing')?.getAttribute('data-mermaid-customise-unavailable')).toBe('true')
  })
})

describe('a slider keeps its movement to itself and writes once', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  it('re-renders nothing above it while it is dragged, and hands on nothing', () => {
    mount(FLOW)
    const rendersBefore = hostRenders
    for (const size of [17, 18, 19, 20, 21, 22, 23, 24]) {
      slideTo(sizeSlider(), size)
    }
    // The readout follows the thumb...
    expect(row('Text size')?.querySelector('output')?.textContent).toBe('150% · 24px')
    expect(sizeSlider().getAttribute('aria-valuetext')).toBe('150% · 24px')
    // ...and nobody else has heard about it: eight ticks, no render above the
    // panel, no edit handed on.
    expect(hostRenders).toBe(rendersBefore)
    expect(edits).toEqual([])
  })

  it('writes the value once, a moment after the drag is released', () => {
    mount(FLOW)
    for (const size of [18, 21, 24]) {
      slideTo(sizeSlider(), size)
    }
    release(sizeSlider())
    expect(edits).toEqual([])
    act(() => {
      jest.advanceTimersByTime(MERMAID_SLIDER_COMMIT_DELAY_MS - 1)
    })
    expect(edits).toEqual([])
    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(edits).toEqual([{ code: fm('config:\n  themeVariables:\n    fontSize: "24px"', FLOW), themeMode: 'app' }])
    expect(sizeSlider().value).toBe('24')
    expect(pressedIn(byLabel('Text size'))).toEqual(['150%'])
  })

  it('writes once for a held arrow key, which fires a change on every repeat', () => {
    mount(FLOW)
    for (const percent of [110, 120, 130, 140, 150]) {
      slideTo(spacingSlider(), percent)
      release(spacingSlider())
      act(() => {
        jest.advanceTimersByTime(30)
      })
    }
    expect(edits).toEqual([])
    act(() => {
      jest.advanceTimersByTime(MERMAID_SLIDER_COMMIT_DELAY_MS)
    })
    expect(edits).toEqual([
      { code: fm('config:\n  flowchart:\n    nodeSpacing: 75\n    rankSpacing: 75', FLOW), themeMode: 'app' },
    ])
  })

  it('writes at once when focus leaves it', () => {
    mount(FLOW)
    slideTo(spacingSlider(), 60)
    release(spacingSlider())
    act(() => {
      spacingSlider().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(edits.map((edit) => edit.code)).toEqual([
      fm('config:\n  flowchart:\n    nodeSpacing: 30\n    rankSpacing: 30', FLOW),
    ])
    // And not a second time when the timer it had started comes due.
    act(() => {
      jest.advanceTimersByTime(MERMAID_SLIDER_COMMIT_DELAY_MS * 2)
    })
    expect(edits).toHaveLength(1)
  })

  it('does not lose a released value when the panel closes before the moment is up', () => {
    mount(FLOW)
    slideTo(sizeSlider(), 20)
    release(sizeSlider())
    expect(edits).toEqual([])
    act(() => root.unmount())
    expect(edits.map((edit) => edit.code)).toEqual([fm('config:\n  themeVariables:\n    fontSize: "20px"', FLOW)])
    root = createRoot(container)
  })

  it('goes back to where the text is when the write is refused', () => {
    const directed = `%%{init: {"themeVariables":{"fontSize":"20px"}}}%%\n${FLOW}`
    mount(directed)
    expect(sizeSlider().value).toBe('20')
    slideTo(sizeSlider(), 30)
    release(sizeSlider())
    act(() => {
      jest.advanceTimersByTime(MERMAID_SLIDER_COMMIT_DELAY_MS)
    })
    expect(edits).toEqual([])
    expect(alertBox()?.getAttribute('data-mermaid-customise-refusal')).toBe('directive-sets-key')
    expect(sizeSlider().value).toBe('20')
  })

  it('follows the text when it changes underneath, dropping a draft', () => {
    mount(FLOW)
    slideTo(sizeSlider(), 30)
    // Something else writes the diagram — a preset here; an undo or a
    // collaborator in the app.
    click(preset('compact'))
    expect(sizeSlider().value).toBe('14')
  })
})

describe('a frontmatter the panel cannot keep exactly', () => {
  const COMMENTED = fm('# colours agreed with Sam\nconfig:\n  look: classic', FLOW)

  it('says so as soon as it opens, without claiming to have tried anything', () => {
    mount(COMMENTED)
    const notice = standing('frontmatter')
    expect(notice?.textContent).toContain('The diagram’s frontmatter has a YAML comment on line 2.')
    expect(notice?.textContent).toContain('edit its options in the code')
    expect(notice?.textContent).not.toContain('nothing was changed')
    expect(alertBox()).toBeNull()
    // No preset is claimed for a text that cannot be read.
    expect(Array.from(container.querySelectorAll('[data-mermaid-preset][aria-pressed="true"]'))).toHaveLength(0)
    expect(themeSelect().value).toBe('__set-in-text')
    expect(themeSelect().selectedOptions[0].textContent).toBe('Set in the diagram’s text')
  })

  it('refuses every control, shows the reason by name, and hands on nothing', () => {
    mount(COMMENTED)
    const attempts: (() => void)[] = [
      () => click(preset('monochrome')),
      () => choose(themeSelect(), 'forest'),
      () => click(buttonIn(byLabel('Diagram look'), 'Hand-drawn')),
      () => click(buttonIn(byLabel('Text size'), '125%')),
      () => click(buttonIn(byLabel('Spacing'), 'Compact')),
      () => choose(byLabel('Line style') as HTMLSelectElement, 'linear'),
      () => click(resetButton()),
    ]
    for (const attempt of attempts) {
      attempt()
      expect(alertBox()?.getAttribute('data-mermaid-customise-refusal')).toBe('yaml-comment')
      expect(alertBox()?.textContent).toContain('Not changed')
      expect(alertBox()?.textContent).toContain('a YAML comment on line 2')
      expect(alertBox()?.textContent).toContain('nothing was changed')
      click(buttonIn(alertBox(), 'Dismiss'))
      expect(alertBox()).toBeNull()
    }
    expect(edits).toEqual([])
    expect(held.code).toBe(COMMENTED)
  })
})

describe('an init directive that overrides the panel', () => {
  const DIRECTED = `%%{init: {"theme":"forest","flowchart":{"curve":"step"}}}%%\n${FLOW}`

  it('is named on the page with the line and the options it decides', () => {
    mount(DIRECTED)
    expect(standing('directive')?.textContent).toBe(
      'Line 1 of the diagram’s text is an init directive that sets theme, flowchart.curve. It wins over anything chosen here; edit that line to change them.',
    )
    // The controls show what the directive makes true.
    expect(themeSelect().value).toBe('forest')
    expect(row('Theme')?.textContent).toContain('Set by an init directive on line 1')
    expect((byLabel('Line style') as HTMLSelectElement).value).toBe('step')
  })

  it('refuses the option it decides, says the directive wins, and hands on nothing', () => {
    mount(DIRECTED)
    choose(themeSelect(), 'dark')
    expect(alertBox()?.getAttribute('data-mermaid-customise-refusal')).toBe('directive-sets-key')
    expect(alertBox()?.textContent).toContain('Line 1 is an init directive that sets "theme" itself')
    expect(alertBox()?.textContent).toContain('a directive wins over the frontmatter')
    expect(edits).toEqual([])
    expect(themeSelect().value).toBe('forest')
  })

  it('still writes an option the directive leaves alone, and clears the refusal when it does', () => {
    mount(DIRECTED)
    choose(themeSelect(), 'dark')
    expect(alertBox()).not.toBeNull()
    click(buttonIn(byLabel('Text size'), '125%'))
    expect(alertBox()).toBeNull()
    expect(held.code).toBe(fm('config:\n  themeVariables:\n    fontSize: "20px"', DIRECTED))
  })

  it('warns in general terms about a directive it cannot follow', () => {
    mount(`%%{init: {"config":{"curve":"step"}}}%%\n${FLOW}`)
    expect(standing('directive')?.textContent).toContain('is an init directive this panel cannot read')
  })
})

describe('a refusal that happened before the panel opened', () => {
  const NOTICE: MermaidConfigRefusal = {
    code: 'yaml-comment',
    line: 2,
    message: 'The diagram’s frontmatter has a YAML comment on line 2. Nothing was changed.',
  }

  it('is shown as the panel’s own, where the reason has room', () => {
    mount(FLOW, 'app', NOTICE)
    expect(alertBox()?.textContent).toContain('The diagram’s frontmatter has a YAML comment on line 2.')
  })

  it('goes when a change is then made successfully', () => {
    mount(FLOW, 'app', NOTICE)
    choose(themeSelect(), 'forest')
    expect(alertBox()).toBeNull()
  })
})

describe('what the text holds that a control does not offer', () => {
  it('is named under the control, which then shows no choice as in force', () => {
    mount(fm('config:\n  look: neo\n  themeVariables:\n    fontSize: 1.5em', FLOW))
    expect(pressedIn(byLabel('Diagram look'))).toEqual([])
    expect(row('Look')?.textContent).toContain('look is "neo" in the diagram’s text')
    expect(pressedIn(byLabel('Text size'))).toEqual([])
    expect(row('Text size')?.textContent).toContain('themeVariables.fontSize is "1.5em" in the diagram’s text')
    // No preset describes it either.
    expect(Array.from(container.querySelectorAll('[data-mermaid-preset][aria-pressed="true"]'))).toHaveLength(0)
  })

  it('is replaced when a choice is made', () => {
    mount(fm('config:\n  look: neo', FLOW))
    click(buttonIn(byLabel('Diagram look'), 'Classic'))
    expect(held.code).toBe(FLOW)
  })
})

describe('the theme control on its own, as the ribbon mounts it', () => {
  let refusals: MermaidConfigRefusal[]

  const mountSelect = (code: string, themeMode: MermaidThemeMode) => {
    refusals = []
    act(() => {
      root.render(
        <MermaidEffectiveThemeSelect
          code={code}
          themeMode={themeMode}
          onApply={(edit) => edits.push(edit)}
          onRefused={(refusal) => refusals.push(refusal)}
        />,
      )
    })
  }

  it('shows the theme the diagram is DRAWN in, which is the text’s and not the block’s', () => {
    // The defect: a block pinned to Forest whose text says dark was drawn dark
    // while this control said Forest.
    mountSelect(fm('config:\n  theme: dark', FLOW), 'forest')
    expect(themeSelect().value).toBe('dark')
    expect(themeSelect().getAttribute('title')).toBe('Written in the diagram’s text, line 3.')
  })

  it('shows the block’s theme when the text names none', () => {
    mountSelect(FLOW, 'neutral')
    expect(themeSelect().value).toBe('neutral')
    expect(themeSelect().getAttribute('title')).toContain('Pinned on this block')
  })

  it('reports a refusal to its caller instead of swallowing it, and hands on no edit', () => {
    mountSelect(`%%{init: {"theme":"forest"}}%%\n${FLOW}`, 'app')
    choose(themeSelect(), 'dark')
    expect(edits).toEqual([])
    expect(refusals.map((refusal) => refusal.code)).toEqual(['directive-sets-key'])
    // A controlled select: it goes on showing what is true.
    expect(themeSelect().value).toBe('forest')
  })
})

describe('the button that opens the panel', () => {
  it('draws a glyph, never the icon’s name as text, and hands over its own element', () => {
    const anchors: HTMLElement[] = []
    act(() => {
      root.render(<MermaidCustomiseButton open={false} onToggle={(anchor) => anchors.push(anchor)} />)
    })
    const button = container.querySelector('[data-mermaid-customise-button="true"]') as HTMLButtonElement
    // An unmapped icon name renders `<label>themes</label>` in place of an <svg>.
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.querySelector('label')).toBeNull()
    expect(button.textContent).toBe('Customise…')
    expect(button.getAttribute('aria-label')).toBe('Customise the diagram')
    click(button)
    expect(anchors).toEqual([button])
  })

  it('shows as pressed while its panel is open', () => {
    act(() => {
      root.render(<MermaidCustomiseButton open onToggle={() => undefined} />)
    })
    expect(container.querySelector('button')?.className).toContain('bg-info')
  })
})
