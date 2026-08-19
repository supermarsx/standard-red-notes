/**
 * The half of the per-item schedule reveal that lives in CSS and therefore
 * cannot be observed through the DOM in jsdom.
 *
 * Two things must not regress, and both are easy to "tidy away" by accident:
 *
 *  1. The reveal must never become `display`-based. Rows would jump every time
 *     the caret moved, which reads as the editor glitching.
 *  2. The mouse path (`:hover`) must never be the ONLY path. An affordance that
 *     exists only on hover is unreachable from a keyboard; the caret-driven
 *     `[data-checklist-due-reveal='active']` rule is the one that has to work
 *     without a pointing device, and `:focus-within` keeps it up once the
 *     control itself takes focus.
 *
 * Reading the stylesheet is the only way to assert either, so we do that
 * deliberately rather than pretending a DOM test covers it.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const STYLESHEET = join(__dirname, '..', 'Lexical', 'Theme', 'lists.scss')

/** The declarations that govern showing/hiding the per-row controls. */
const revealRules = (): string => {
  const source = readFileSync(STYLESHEET, 'utf8')
  const start = source.indexOf(".checklist-due-shell[data-checklist-due-reveal='inactive']")
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('.checklist-due-icon-button', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('the per-item schedule reveal stylesheet', () => {
  it('hides inactive rows with visibility, never display, so nothing reflows', () => {
    const rules = revealRules()
    expect(rules).toContain('visibility: hidden')
    expect(rules).toContain('opacity: 0')
    expect(rules).not.toContain('display: none')
  })

  it('reveals on the caret — the path that works without a mouse', () => {
    expect(revealRules()).toContain(
      ".checklist-due-shell[data-checklist-due-reveal='active'] > .checklist-due-controls",
    )
  })

  it('also reveals on hover and on focus-within, never on hover alone', () => {
    const rules = revealRules()
    expect(rules).toContain('li:hover > .checklist-due-shell > .checklist-due-controls')
    expect(rules).toContain('li:focus-within > .checklist-due-shell > .checklist-due-controls')
  })

  it('keeps the icon compact and colour-coded by schedule state', () => {
    const source = readFileSync(STYLESHEET, 'utf8')
    expect(source).toContain(".checklist-due-icon-button[data-checklist-due-state='scheduled']")
    expect(source).toContain('.checklist-due-icon')
  })
})
