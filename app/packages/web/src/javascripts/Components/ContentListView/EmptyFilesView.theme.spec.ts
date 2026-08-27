/**
 * Asset-level guard for the theme-awareness of the files empty state.
 *
 * This deliberately does NOT render anything. Two reasons, both structural:
 *  - `web`'s jest config maps `\.svg$` to `svg-jest`, so an imported illustration
 *    is a stub component with none of its real markup. A render test could not see
 *    a fill even in principle.
 *  - jsdom does not evaluate CSS custom properties or theme stylesheets, so
 *    "it looks right in dark mode" is not assertable here at all.
 *
 * What IS checkable is the claim the fix actually makes: every colour in these
 * illustrations resolves through a stylekit CSS variable that exists, with a
 * fallback, and no light-theme literal is left baked into a presentation
 * attribute. That is what this asserts.
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'

const PACKAGES_DIR = resolve(__dirname, '../../../../..')
const ICONS_DIR = resolve(PACKAGES_DIR, 'icons/src/Icons')
const COLORS_SCSS = resolve(PACKAGES_DIR, 'styles/src/Styles/_colors.scss')
const EMPTY_FILES_VIEW = resolve(__dirname, 'EmptyFilesView.tsx')

/**
 * The illustrations that must be theme-driven: the one the report is about, the
 * sibling that backs the adjacent "N selected" placeholders, and the two that were
 * already converted — included so they cannot silently regress.
 */
const THEMED_ILLUSTRATIONS = ['il-files.svg', 'il-notes.svg', 'il-protected.svg', 'il-no-preview.svg']

/** `fill` values that carry no colour of their own and are therefore fine as attributes. */
const COLORLESS_FILL_VALUES = /^(none|currentColor|url\(#[^)]*\))$/

/**
 * Illustration markup with XML comments removed. The converted assets document the
 * light-theme literals they replaced, and quote `fill="var(...)"` as the form that
 * does NOT work — so every check below has to read the artwork, not the prose about it.
 */
const readIllustration = (name: string) =>
  readFileSync(resolve(ICONS_DIR, name), 'utf8').replace(/<!--[\s\S]*?-->/g, '')

const definedStylekitTokens = (): Set<string> => {
  const scss = readFileSync(COLORS_SCSS, 'utf8')
  return new Set([...scss.matchAll(/(--sn-stylekit-[a-z0-9-]+)\s*:/g)].map((match) => match[1]))
}

describe('files empty state is theme-driven', () => {
  describe.each(THEMED_ILLUSTRATIONS)('%s', (name) => {
    const source = readIllustration(name)

    it('bakes no colour into a fill presentation attribute', () => {
      const attributeFills = [...source.matchAll(/\bfill="([^"]*)"/g)].map((match) => match[1])
      const colouredFills = attributeFills.filter((value) => !COLORLESS_FILL_VALUES.test(value))

      expect(colouredFills).toEqual([])
    })

    it('carries no light-theme literal anywhere in the artwork', () => {
      // The exact palette every unconverted illustration in this set shipped with.
      const lightThemeLiterals = /#F4F5F7|#BBBEC4|fill="white"/i
      // The fallbacks inside var() are intentionally those same literals, so strip
      // them before looking: only an UNGUARDED literal is a defect.
      const withoutFallbacks = source.replace(/var\(--[a-z0-9-]+,\s*[^)]*\)/gi, 'var(TOKEN)')

      expect(withoutFallbacks).not.toMatch(lightThemeLiterals)
    })

    it('routes every colour through a stylekit variable that actually exists', () => {
      const referencedTokens = [...source.matchAll(/var\((--sn-stylekit-[a-z0-9-]+)/g)].map((match) => match[1])
      const defined = definedStylekitTokens()

      expect(referencedTokens.length).toBeGreaterThan(0)
      // A typo'd custom property does not error — it silently paints nothing —
      // so cross-check each name against the stylekit that defines them.
      expect(referencedTokens.filter((token) => !defined.has(token))).toEqual([])
    })
  })

  it('il-files.svg maps its parts to the same tokens as its already-converted siblings', () => {
    const source = readIllustration('il-files.svg')

    // disc, sheet, details — the mapping il-no-preview.svg established
    // (text-contrast / text-default / text-passive-2 in Tailwind terms).
    expect(source).toContain('var(--sn-stylekit-contrast-background-color')
    expect(source).toContain('var(--sn-stylekit-background-color')
    expect(source).toContain('var(--sn-stylekit-passive-color-2')
  })

  it('the rest of the empty state uses theme classes, not literal colours', () => {
    const component = readFileSync(EMPTY_FILES_VIEW, 'utf8')

    // Text, border and background all have to come from the theme too; fixing only
    // the graphic leaves a half-converted panel.
    expect(component).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(component).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i)
    expect(component).not.toMatch(/\b(?:text|bg|border)-(?:white|black)\b/)
  })
})
