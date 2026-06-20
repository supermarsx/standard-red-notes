import { mathPlaceholder, replaceInlineMath, MATH_PLACEHOLDER_CLASS } from './markdownMath'

// These tests cover the *pure* math-detection helpers. The actual KaTeX
// rendering (the DOM hydrator) is lazy/async and exercised at runtime, not here.

describe('markdownMath detection', () => {
  describe('mathPlaceholder', () => {
    it('builds an inline (span) placeholder carrying the raw tex', () => {
      const html = mathPlaceholder('x^2', false)
      expect(html).toContain(`<span class="${MATH_PLACEHOLDER_CLASS}"`)
      expect(html).toContain('data-md-katex-tex="x^2"')
      expect(html).toContain('data-md-katex-display="0"')
      // Fallback text preserves the original source so it survives if KaTeX never loads.
      expect(html).toContain('$x^2$')
    })

    it('builds a block (div) placeholder in display mode', () => {
      const html = mathPlaceholder('a+b', true)
      expect(html).toContain(`<div class="${MATH_PLACEHOLDER_CLASS}"`)
      expect(html).toContain('data-md-katex-display="1"')
      expect(html).toContain('$$a+b$$')
    })

    it('escapes html-significant characters in the tex attribute and fallback', () => {
      const html = mathPlaceholder('a<b & c>d', false)
      expect(html).toContain('data-md-katex-tex="a&lt;b &amp; c&gt;d"')
      expect(html).toContain('$a&lt;b &amp; c&gt;d$')
      expect(html).not.toContain('<b')
    })
  })

  describe('replaceInlineMath', () => {
    const hasMath = (s: string) => s.includes(MATH_PLACEHOLDER_CLASS)
    const texOf = (s: string) => {
      const m = s.match(/data-md-katex-tex="([^"]*)"/)
      return m ? m[1] : null
    }

    it('renders a simple inline span', () => {
      const out = replaceInlineMath('an equation $x^2$ here')
      expect(hasMath(out)).toBe(true)
      expect(texOf(out)).toBe('x^2')
    })

    it('renders single-character inline math', () => {
      expect(texOf(replaceInlineMath('$x$'))).toBe('x')
    })

    it('renders the \\( ... \\) form', () => {
      const out = replaceInlineMath('value \\(a+b\\) end')
      expect(hasMath(out)).toBe(true)
      expect(texOf(out)).toBe('a+b')
    })

    it('does NOT treat prices as math (space after opening $)', () => {
      expect(hasMath(replaceInlineMath('it costs $ 5 today'))).toBe(false)
    })

    it('does NOT match when the closing delimiter is preceded by a space', () => {
      expect(hasMath(replaceInlineMath('a $x $ b'))).toBe(false)
    })

    it('does NOT match an empty $$ (left for the block path)', () => {
      expect(hasMath(replaceInlineMath('$$'))).toBe(false)
    })

    it('does NOT match a lone $ with no closer', () => {
      expect(hasMath(replaceInlineMath('I have $5 and more'))).toBe(false)
    })

    it('decodes html entities back to real latex when read from the DOM', () => {
      // markdownToHtml escapes text before calling this, so `<` arrives as &lt;.
      // The data attribute is then re-escaped for HTML; getAttribute() decodes it
      // back to the real LaTeX that KaTeX needs.
      const out = replaceInlineMath('$a &lt; b$')
      const span = document.createElement('span')
      span.innerHTML = out
      const el = span.querySelector(`.${MATH_PLACEHOLDER_CLASS}`)
      expect(el?.getAttribute('data-md-katex-tex')).toBe('a < b')
    })

    it('renders two inline spans on one line', () => {
      const out = replaceInlineMath('$a$ and $b$')
      const count = (out.match(/class="md-katex"/g) || []).length
      expect(count).toBe(2)
    })
  })
})
