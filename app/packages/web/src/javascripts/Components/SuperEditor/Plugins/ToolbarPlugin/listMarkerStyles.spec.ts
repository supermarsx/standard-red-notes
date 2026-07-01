/**
 * Regression tests for the custom list-marker GLYPH CSS (lists.scss).
 *
 * Bug: custom bullet markers rendered with literal quote characters around the
 * glyph (e.g. the dash bullet showed `"–"` instead of `–`). Cause: the
 * `sn-list-marker` mixin was invoked with the glyph DOUBLE-quoted
 * (`@include sn-list-marker('"–  "')`), so the SCSS string's literal characters
 * included the surrounding double-quotes and compiled to `content: '"–  "'`,
 * which the browser renders WITH the quotes.
 *
 * These specs compile the real SCSS with the `sass` compiler and assert that each
 * custom-glyph `::marker` `content` is a single, properly-quoted CSS string whose
 * value is the bare glyph — no literal quote characters inside it.
 */
import * as path from 'path'
import * as sass from 'sass'

const LISTS_SCSS = path.resolve(__dirname, '../../Lexical/Theme/lists.scss')

/** Custom-glyph bullet markers and the glyph each must render (no quotes). */
const CUSTOM_GLYPH_MARKERS: ReadonlyArray<{ value: string; glyph: string }> = [
  { value: 'dash', glyph: '–' },
  { value: 'arrow', glyph: '▸' },
  { value: 'arrow-alt', glyph: '→' },
  { value: 'triangle', glyph: '‣' },
  { value: 'diamond', glyph: '◆' },
  { value: 'star', glyph: '★' },
  { value: 'chevron', glyph: '»' },
  { value: 'tickbox', glyph: '☐' },
  { value: 'cross', glyph: '✗' },
]

let compiledCss = ''

beforeAll(() => {
  compiledCss = sass.compile(LISTS_SCSS, { style: 'expanded' }).css
})

/** Extract the `content` value of `.Lexical__listStyle--<value> > li::marker`. */
const markerContentFor = (value: string): string | null => {
  const block = new RegExp(
    `\\.Lexical__listStyle--${value}\\s*>\\s*li::marker\\s*\\{([^}]*)\\}`,
  ).exec(compiledCss)
  if (!block) {
    return null
  }
  const content = /content:\s*([^;]+);/.exec(block[1])
  return content ? content[1].trim() : null
}

/** Strip ONE layer of matching outer CSS-string quotes, if present. */
const unquote = (raw: string): string => {
  const m = /^(['"])([\s\S]*)\1$/.exec(raw)
  return m ? m[2] : raw
}

describe('custom list-marker glyph CSS', () => {
  it.each(CUSTOM_GLYPH_MARKERS)(
    '$value marker renders the bare glyph with no literal quotes',
    ({ value, glyph }) => {
      const raw = markerContentFor(value)
      expect(raw).not.toBeNull()

      const inner = unquote(raw as string)
      // The actual marker string the browser shows must NOT contain quote chars.
      expect(inner).not.toContain('"')
      expect(inner).not.toContain("'")
      // ...and it must still contain the intended glyph.
      expect(inner).toContain(glyph)
    },
  )
})
