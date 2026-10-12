/**
 * @jest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { IconNameToSvgMapping } from '@/Components/Icon/IconNameToSvgMapping'
import { STATUS_ICON, STATUS_STYLE, StatusChip } from './diagnosticsPresentation'
import { VERDICT_CHIP_LABEL, VERDICTS, type Verdict } from './diagnosticsSections'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * *** `Icon` IS NOT MOCKED IN THIS FILE, AND THAT IS THE WHOLE POINT OF IT. ***
 *
 * An `Icon` whose `type` is missing from `IconNameToSvgMapping` renders its own
 * name as literal text inside a `label`. `Icon` accepts any string, so tsc cannot
 * see it, and nearly every component spec in this package stubs `Icon` to null,
 * so they cannot either. It has reached users three times.
 *
 * `STATUS_ICON` closes that by TYPE — its values are the mapping's own keys — and
 * a type is erased, so this is the runtime half: every status is mounted through
 * the real `Icon` and asserted to have drawn a glyph and no fallback.
 */

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const renderChip = async (verdict: Verdict, props: { label?: string; large?: boolean } = {}): Promise<HTMLElement> => {
  await act(async () => {
    root.render(createElement(StatusChip, { verdict, ...props }))
  })
  const chip = container.querySelector('[data-diagnostics-status]')
  expect(chip).not.toBeNull()

  return chip as HTMLElement
}

describe('StatusChip', () => {
  it('has an icon, a style and a word for every verdict, and no two share an icon or a word', () => {
    expect(Object.keys(STATUS_ICON).sort()).toEqual([...VERDICTS].sort())
    expect(Object.keys(STATUS_STYLE).sort()).toEqual([...VERDICTS].sort())
    // Never colour alone: seven statuses, seven shapes, seven words.
    expect(new Set(Object.values(STATUS_ICON)).size).toBe(VERDICTS.length)
    expect(new Set(Object.values(VERDICT_CHIP_LABEL)).size).toBe(VERDICTS.length)
  })

  it('names only icons the mapping can actually render', () => {
    for (const verdict of VERDICTS) {
      expect({ verdict, mapped: Object.hasOwn(IconNameToSvgMapping, STATUS_ICON[verdict]) }).toEqual({
        verdict,
        mapped: true,
      })
    }
  })

  it('draws exactly one glyph for every verdict, and falls back to a name for none', async () => {
    const glyphs: string[] = []

    for (const verdict of VERDICTS) {
      const chip = await renderChip(verdict)

      expect(chip.getAttribute('data-diagnostics-status')).toBe(verdict)
      expect({ verdict, svgs: chip.querySelectorAll('svg').length }).toEqual({ verdict, svgs: 1 })
      // The unmapped-name fallback is a `label` carrying the name as text.
      expect({ verdict, labels: container.querySelectorAll('label').length }).toEqual({ verdict, labels: 0 })
      expect(chip.textContent).not.toContain(STATUS_ICON[verdict])
      // The word is the accessible name; the glyph is decoration and says so.
      expect(chip.textContent).toBe(VERDICT_CHIP_LABEL[verdict])
      expect(chip.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
      glyphs.push(chip.querySelector('svg')?.innerHTML ?? '')
    }

    // Seven DIFFERENT drawings, not one drawing seven times.
    expect(new Set(glyphs).size).toBe(VERDICTS.length)
    expect(glyphs.every((glyph) => glyph.length > 0)).toBe(true)
  })

  it('paints each verdict with its own classes, so a status is never told apart by its word alone', async () => {
    for (const verdict of VERDICTS) {
      const chip = await renderChip(verdict)

      for (const className of STATUS_STYLE[verdict].split(' ')) {
        expect({ verdict, className, has: chip.classList.contains(className) }).toEqual({
          verdict,
          className,
          has: true,
        })
      }
    }
    // The two quiet statuses that keep a headline off OK do not look alike.
    expect(STATUS_STYLE.untested).not.toBe(STATUS_STYLE.undetermined)
    expect(STATUS_STYLE.untested).not.toBe(STATUS_STYLE.informational)
    expect(STATUS_STYLE.undetermined).not.toBe(STATUS_STYLE.informational)
  })

  it('lets a caller change the word and never the verdict, the glyph or the colour', async () => {
    const plain = await renderChip('untested')
    const glyph = plain.querySelector('svg')?.innerHTML
    const relabelled = await renderChip('untested', { label: 'Not tested yet', large: true })

    expect(relabelled.textContent).toBe('Not tested yet')
    expect(relabelled.getAttribute('data-diagnostics-status')).toBe('untested')
    expect(relabelled.querySelector('svg')?.innerHTML).toBe(glyph)
    expect(relabelled.classList.contains('text-info')).toBe(true)
  })
})
