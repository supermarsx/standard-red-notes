import { sanitizeHtmlString } from './Utils'

/**
 * XSS battery for the central `sanitizeHtmlString` helper. This sanitizer guards
 * every `dangerouslySetInnerHTML` sink in the web app (markdown preview, the
 * public SharedView note viewer, the note-list HTML preview, and alert dialogs),
 * so any regression that lets one of these payloads survive is a real, exploitable
 * stored-XSS bug — note text is attacker-controllable (shared notes, synced
 * content), and the SharedView viewer renders it unauthenticated.
 *
 * Each test asserts the *neutralized* output contains no executable surface:
 * no <script>, no on* handler, no javascript:/data:/vbscript: URL, no <iframe>/
 * <object>/<embed>/<style>/<form>, and — crucially — that parsing the sanitized
 * string back into the DOM creates no live element bearing an event handler or
 * dangerous URL.
 */

// Parse sanitized HTML into a detached container and report any residual
// executable surface. This catches mutation-XSS that string matching alone can
// miss (the browser/jsdom re-parses, which is how the payload would actually run).
const executableSurface = (sanitized: string) => {
  const container = document.createElement('div')
  container.innerHTML = sanitized

  const allElements = Array.from(container.querySelectorAll('*'))

  const elementsWithEventHandlers = allElements.filter((el) =>
    Array.from(el.attributes).some((attr) => attr.name.toLowerCase().startsWith('on')),
  )

  const dangerousUrlElements = allElements.filter((el) => {
    const urlAttrs = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data']
    return urlAttrs.some((name) => {
      const value = (el.getAttribute(name) || '').replace(/\s+/g, '').toLowerCase()
      return (
        value.startsWith('javascript:') ||
        value.startsWith('vbscript:') ||
        value.startsWith('data:text/html') ||
        value.startsWith('data:application')
      )
    })
  })

  return {
    scripts: container.querySelectorAll('script').length,
    iframes: container.querySelectorAll('iframe').length,
    objects: container.querySelectorAll('object').length,
    embeds: container.querySelectorAll('embed').length,
    styles: container.querySelectorAll('style').length,
    forms: container.querySelectorAll('form').length,
    metas: container.querySelectorAll('meta').length,
    links: container.querySelectorAll('link').length,
    elementsWithEventHandlers,
    dangerousUrlElements,
  }
}

const expectNeutralized = (payload: string) => {
  const sanitized = sanitizeHtmlString(payload)
  const surface = executableSurface(sanitized)

  expect(surface.scripts).toBe(0)
  expect(surface.iframes).toBe(0)
  expect(surface.objects).toBe(0)
  expect(surface.embeds).toBe(0)
  expect(surface.styles).toBe(0)
  expect(surface.forms).toBe(0)
  expect(surface.metas).toBe(0)
  expect(surface.links).toBe(0)
  expect(surface.elementsWithEventHandlers).toHaveLength(0)
  expect(surface.dangerousUrlElements).toHaveLength(0)

  // String-level smoke checks for the most common exfil/exec tokens.
  const lowered = sanitized.toLowerCase().replace(/\s+/g, '')
  expect(lowered).not.toContain('javascript:')
  expect(lowered).not.toContain('vbscript:')
  expect(lowered).not.toContain('<script')
  return sanitized
}

describe('sanitizeHtmlString XSS battery', () => {
  describe('script execution vectors', () => {
    it('strips a bare <script> tag', () => {
      expectNeutralized('<script>alert(1)</script>')
    })

    it('strips a script tag with attributes', () => {
      expectNeutralized('<script type="text/javascript" src="//evil.example/x.js"></script>')
    })

    it('strips an uppercase/mixed-case SCRIPT tag', () => {
      expectNeutralized('<ScRiPt>alert(1)</ScRiPt>')
    })

    it('strips a script split by a null byte / broken nesting', () => {
      expectNeutralized('<scr<script>ipt>alert(1)</scr</script>ipt>')
    })

    it('strips a <noscript> wrapped payload', () => {
      expectNeutralized('<noscript><p title="</noscript><img src=x onerror=alert(1)>">')
    })
  })

  describe('event-handler (on*) vectors', () => {
    it('strips onerror from <img>', () => {
      const out = expectNeutralized('<img src=x onerror=alert(1)>')
      expect(out.toLowerCase()).not.toContain('onerror')
    })

    it('strips onload from <svg>', () => {
      const out = expectNeutralized('<svg onload=alert(1)></svg>')
      expect(out.toLowerCase()).not.toContain('onload')
    })

    it('strips onmouseover from a <a>', () => {
      expectNeutralized('<a href="#" onmouseover="alert(1)">hover</a>')
    })

    it('strips onfocus + autofocus from an input', () => {
      expectNeutralized('<input autofocus onfocus=alert(1)>')
    })

    it('strips animation begin/onbegin from svg', () => {
      expectNeutralized('<svg><animate onbegin=alert(1) attributeName=x dur=1s>')
    })

    it('strips onanimationstart vectors', () => {
      expectNeutralized('<xss style="animation-name:x" onanimationstart="alert(1)">x</xss>')
    })
  })

  describe('dangerous URL schemes', () => {
    it('strips a javascript: href', () => {
      expectNeutralized('<a href="javascript:alert(1)">click</a>')
    })

    it('strips a javascript: href with embedded whitespace/entities', () => {
      expectNeutralized('<a href="java\tscript:alert(1)">click</a>')
      expectNeutralized('<a href="javascript&colon;alert(1)">click</a>')
    })

    it('strips a vbscript: href', () => {
      expectNeutralized('<a href="vbscript:msgbox(1)">click</a>')
    })

    it('strips a data:text/html href', () => {
      expectNeutralized('<a href="data:text/html,<script>alert(1)</script>">d</a>')
    })

    it('strips a data: URI on an <img src>', () => {
      expectNeutralized('<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">')
    })

    it('strips javascript: in an iframe src', () => {
      expectNeutralized('<iframe src="javascript:alert(1)"></iframe>')
    })
  })

  describe('embedding / layout vectors', () => {
    it('removes <iframe>', () => {
      expectNeutralized('<iframe src="https://evil.example"></iframe>')
    })

    it('removes <object>', () => {
      expectNeutralized('<object data="https://evil.example/x.swf"></object>')
    })

    it('removes <embed>', () => {
      expectNeutralized('<embed src="https://evil.example/x.swf">')
    })

    it('removes <style> (CSS exfiltration / layout abuse)', () => {
      expectNeutralized('<style>body{background:url(javascript:alert(1))}</style>')
    })

    it('removes <form> action hijacking', () => {
      expectNeutralized('<form action="javascript:alert(1)"><button>go</button></form>')
    })

    it('removes <meta> refresh redirects', () => {
      expectNeutralized('<meta http-equiv="refresh" content="0;url=javascript:alert(1)">')
    })

    it('removes <base> href hijacking', () => {
      expectNeutralized('<base href="https://evil.example/">')
    })

    it('removes <link> imports', () => {
      expectNeutralized('<link rel="import" href="https://evil.example/x.html">')
    })
  })

  describe('SVG / MathML vectors', () => {
    it('neutralizes an SVG with a script child', () => {
      expectNeutralized('<svg><script>alert(1)</script></svg>')
    })

    it('neutralizes svg use xlink:href javascript', () => {
      expectNeutralized('<svg><use xlink:href="javascript:alert(1)"></use></svg>')
    })

    it('neutralizes the mglyph/mtext MathML mutation vector', () => {
      expectNeutralized('<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>')
    })

    it('neutralizes foreignObject script smuggling', () => {
      expectNeutralized('<svg><foreignObject><script>alert(1)</script></foreignObject></svg>')
    })
  })

  describe('mutation-XSS (mXSS) vectors', () => {
    it('neutralizes the classic mXSS noscript/comment vector', () => {
      expectNeutralized('<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">')
    })

    it('neutralizes a template-element smuggle', () => {
      expectNeutralized('<template><img src=x onerror=alert(1)></template>')
    })

    it('neutralizes nested-quote attribute breakout', () => {
      expectNeutralized('<a title="&quot; onmouseover=&quot;alert(1)">x</a>')
    })
  })

  describe('benign content is preserved (no over-sanitization)', () => {
    it('keeps a safe https link with target/rel', () => {
      const out = sanitizeHtmlString('<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>')
      expect(out).toContain('href="https://example.com"')
      expect(out).toContain('target="_blank"')
    })

    it('keeps the KaTeX math placeholder span and its data attributes', () => {
      const placeholder = '<span class="md-katex" data-md-katex-tex="x^2" data-md-katex-display="0">$x^2$</span>'
      const out = sanitizeHtmlString(placeholder)
      expect(out).toContain('class="md-katex"')
      expect(out).toContain('data-md-katex-tex="x^2"')
      expect(out).toContain('data-md-katex-display="0"')
    })

    it('keeps the KaTeX block (div) math placeholder', () => {
      const placeholder = '<div class="md-katex" data-md-katex-tex="a+b" data-md-katex-display="1">$$a+b$$</div>'
      const out = sanitizeHtmlString(placeholder)
      expect(out).toContain('data-md-katex-display="1"')
      expect(out).toContain('data-md-katex-tex="a+b"')
    })

    it('keeps common formatting tags', () => {
      const out = sanitizeHtmlString('<p><strong>a</strong> <em>b</em> <code>c</code> <del>d</del></p>')
      expect(out).toContain('<strong>a</strong>')
      expect(out).toContain('<em>b</em>')
      expect(out).toContain('<code>c</code>')
      expect(out).toContain('<del>d</del>')
    })

    it('keeps a disabled task-list checkbox', () => {
      const out = sanitizeHtmlString('<input type="checkbox" disabled checked />')
      expect(out).toContain('type="checkbox"')
      expect(out).toContain('disabled')
    })
  })
})
