import { sanitizeHtmlString } from '@standardnotes/utils'
import { markdownToHtml } from './markdownToHtml'

/**
 * End-to-end XSS tests for the *exact* pipeline the plain-editor preview and the
 * public SharedView note viewer run on attacker-controllable note text:
 *
 *     sanitizeHtmlString(markdownToHtml(noteText))
 *
 * markdownToHtml is documented as producing only "structurally reasonable" HTML
 * and relies entirely on the downstream sanitizer for security, so these tests
 * assert the *composed* output is inert. They complement the unit-level battery
 * in @standardnotes/utils/sanitizeHtmlString.spec.ts by exercising the markdown
 * link/image/code/math paths that build raw HTML from user input.
 */

const render = (markdown: string): string => sanitizeHtmlString(markdownToHtml(markdown))

const liveSurface = (html: string) => {
  const container = document.createElement('div')
  container.innerHTML = html
  const all = Array.from(container.querySelectorAll('*'))
  return {
    scripts: container.querySelectorAll('script').length,
    iframes: container.querySelectorAll('iframe').length,
    styles: container.querySelectorAll('style').length,
    handlers: all.filter((el) => Array.from(el.attributes).some((a) => a.name.toLowerCase().startsWith('on'))),
    badUrls: all.filter((el) => {
      const v = (el.getAttribute('href') || el.getAttribute('src') || '').replace(/\s+/g, '').toLowerCase()
      return v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html')
    }),
  }
}

/**
 * Asserts the rendered+sanitized output has NO live executable surface: no
 * <script>/<iframe>/<style>, no on* handler, and no element bearing a
 * javascript:/vbscript:/data:text/html URL. This is the security-relevant check
 * (it re-parses into the DOM, the same way the browser would run the payload).
 *
 * `allowInertSchemeToken` opts out only the *raw-substring* smoke check, for the
 * specific case where a token like "javascript:" legitimately appears as inert
 * LaTeX text inside a `data-md-katex-tex` attribute (it is never a navigable URL
 * there, and KaTeX renders it with trust:false so it cannot become a link).
 */
const expectInert = (markdown: string, allowInertSchemeToken = false): string => {
  const out = render(markdown)
  const surface = liveSurface(out)
  expect(surface.scripts).toBe(0)
  expect(surface.iframes).toBe(0)
  expect(surface.styles).toBe(0)
  expect(surface.handlers).toHaveLength(0)
  expect(surface.badUrls).toHaveLength(0)
  const lowered = out.toLowerCase().replace(/\s+/g, '')
  expect(lowered).not.toContain('<script')
  if (!allowInertSchemeToken) {
    expect(lowered).not.toContain('javascript:')
  }
  return out
}

describe('markdown -> sanitize pipeline XSS', () => {
  describe('raw HTML embedded in markdown', () => {
    it('neutralizes a <script> typed into a note', () => {
      expectInert('here is <script>alert(1)</script> text')
    })

    it('neutralizes an <img onerror> typed into a note', () => {
      expectInert('look: <img src=x onerror=alert(document.cookie)>')
    })

    it('neutralizes an <svg onload> typed into a note', () => {
      expectInert('<svg onload=alert(1)></svg>')
    })

    it('neutralizes an <iframe> typed into a note', () => {
      expectInert('<iframe src="https://evil.example"></iframe>')
    })

    it('neutralizes a <style> typed into a note', () => {
      expectInert('<style>*{display:none}</style>')
    })
  })

  describe('markdown link/image URL injection', () => {
    it('neutralizes a javascript: markdown link', () => {
      // markdownToHtml builds <a href="javascript:..."> verbatim; the sanitizer
      // must drop the scheme.
      const out = expectInert('[click me](javascript:alert(1))')
      expect(out.toLowerCase()).not.toContain('javascript:')
    })

    it('neutralizes a data:text/html markdown link', () => {
      expectInert('[x](data:text/html,<script>alert(1)</script>)')
    })

    it('neutralizes a javascript: markdown image', () => {
      expectInert('![x](javascript:alert(1))')
    })

    it('neutralizes an attribute-breakout attempt in a link URL', () => {
      // Try to break out of the href attribute markdownToHtml emits.
      expectInert('[x](https://a.com" onmouseover="alert(1))')
    })

    it('neutralizes an attribute-breakout attempt in image alt text', () => {
      expectInert('![" onerror="alert(1)](https://a.com/i.png)')
    })

    it('keeps a normal https link working after sanitization', () => {
      const out = render('[ok](https://example.com)')
      expect(out).toContain('href="https://example.com"')
    })
  })

  describe('KaTeX math abuse', () => {
    it('keeps an inline math placeholder but strips nothing executable', () => {
      const out = expectInert('mass is $E=mc^2$')
      expect(out).toContain('class="md-katex"')
      expect(out).toContain('data-md-katex-tex="E=mc^2"')
    })

    it('does not let HTML smuggled through $...$ survive as live markup', () => {
      // The `<img onerror>` here is escaped by markdownToHtml before it ever
      // reaches the math attribute (so it lands as inert &lt;img...&gt; text on
      // the data attribute), and KaTeX (trust:false) escapes it again at
      // hydration time. Assert no live img/handler element exists.
      const out = expectInert('$x<img src=x onerror=alert(1)>$')
      const container = document.createElement('div')
      container.innerHTML = out
      // No live <img> element is created; the payload is escaped text on the
      // inert data-md-katex-tex attribute, not parsed markup.
      expect(container.querySelectorAll('img')).toHaveLength(0)
      expect(container.querySelector('[onerror]')).toBeNull()
    })

    it('does not let a \\href LaTeX command smuggle a navigable javascript URL', () => {
      // The placeholder only carries the raw tex on a data attribute (where a
      // "javascript:" substring is inert text, never a URL the browser acts on);
      // KaTeX is pinned to trust:false so \\href is disabled and emits no <a>.
      // Assert there is no anchor and no element with a navigable javascript URL.
      const out = expectInert('$\\href{javascript:alert(1)}{x}$', true)
      const container = document.createElement('div')
      container.innerHTML = out
      const anchors = Array.from(container.querySelectorAll('a'))
      expect(anchors.every((a) => !(a.getAttribute('href') || '').toLowerCase().includes('javascript:'))).toBe(true)
    })

    it('does not let block math display attribute be abused', () => {
      const out = expectInert('$$\n\\text{<script>alert(1)</script>}\n$$')
      expect(out.toLowerCase()).not.toContain('<script')
    })
  })

  describe('code blocks never execute', () => {
    it('escapes html inside a fenced code block', () => {
      const out = expectInert('```\n<script>alert(1)</script>\n```')
      expect(out).toContain('&lt;script&gt;')
    })

    it('escapes html inside an inline code span', () => {
      expectInert('use `<img src=x onerror=alert(1)>` literally')
    })
  })
})
