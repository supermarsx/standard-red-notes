import {
  SANDBOX_DOCUMENT_VERSION,
  SANDBOX_CONSOLE_CHANNEL,
  SandboxDocument,
  buildSandboxSrcdoc,
  createEmptySandboxDocument,
  createJsSandboxStarter,
  createWebSandboxStarter,
  parseSandboxDocument,
  serializeSandboxDocument,
} from './SandboxDocument'

describe('SandboxDocument', () => {
  describe('createEmptySandboxDocument', () => {
    it('creates a versioned blank document', () => {
      const doc = createEmptySandboxDocument()
      expect(doc).toEqual({
        version: SANDBOX_DOCUMENT_VERSION,
        html: '',
        css: '',
        js: '',
        activePane: 'html',
      })
    })
  })

  describe('serialize/parse round-trip', () => {
    it('round-trips a populated document without data loss', () => {
      const original: SandboxDocument = {
        version: SANDBOX_DOCUMENT_VERSION,
        html: '<h1>Hi</h1>',
        css: 'h1 { color: red; }',
        js: "console.log('hello')",
        activePane: 'js',
      }

      const serialized = serializeSandboxDocument(original)
      const { document, recovered } = parseSandboxDocument(serialized)

      expect(recovered).toBe(true)
      expect(document).toEqual(original)
    })

    it('round-trips the JS sandbox starter', () => {
      const { document } = parseSandboxDocument(serializeSandboxDocument(createJsSandboxStarter()))
      expect(document).toEqual(createJsSandboxStarter())
    })

    it('round-trips the web sandbox starter', () => {
      const { document } = parseSandboxDocument(serializeSandboxDocument(createWebSandboxStarter()))
      expect(document).toEqual(createWebSandboxStarter())
    })
  })

  describe('malformed and legacy input fallback', () => {
    it('returns a blank (recoverable) document for empty string', () => {
      const { document, recovered } = parseSandboxDocument('')
      expect(document).toEqual(createEmptySandboxDocument())
      expect(recovered).toBe(true)
    })

    it('returns a blank (recoverable) document for whitespace', () => {
      const { document, recovered } = parseSandboxDocument('   \n  ')
      expect(document).toEqual(createEmptySandboxDocument())
      expect(recovered).toBe(true)
    })

    it('returns a blank document and flags non-recovery for invalid JSON', () => {
      const { document, recovered } = parseSandboxDocument('{not valid json}')
      expect(document).toEqual(createEmptySandboxDocument())
      expect(recovered).toBe(false)
    })

    it('returns a blank document and flags non-recovery for legacy plain text', () => {
      const { document, recovered } = parseSandboxDocument('This is just a plain note.')
      expect(document).toEqual(createEmptySandboxDocument())
      expect(recovered).toBe(false)
    })

    it('returns a blank document and flags non-recovery for a non-sandbox JSON object', () => {
      const { document, recovered } = parseSandboxDocument(JSON.stringify({ root: { children: [] } }))
      expect(document).toEqual(createEmptySandboxDocument())
      expect(recovered).toBe(false)
    })

    it('never throws on null or undefined', () => {
      expect(() => parseSandboxDocument(null)).not.toThrow()
      expect(() => parseSandboxDocument(undefined)).not.toThrow()
    })
  })

  describe('field sanitization', () => {
    it('coerces non-string panes to empty strings', () => {
      const { document, recovered } = parseSandboxDocument(
        JSON.stringify({ html: '<p>ok</p>', css: 42, js: null }),
      )
      // Recovered because at least one pane (html) is a string.
      expect(recovered).toBe(true)
      expect(document.html).toBe('<p>ok</p>')
      expect(document.css).toBe('')
      expect(document.js).toBe('')
    })

    it('falls back invalid activePane to html', () => {
      const { document } = parseSandboxDocument(JSON.stringify({ js: 'x', activePane: 'nope' }))
      expect(document.activePane).toBe('html')
    })

    it('preserves a valid activePane', () => {
      const { document } = parseSandboxDocument(JSON.stringify({ js: 'x', activePane: 'css' }))
      expect(document.activePane).toBe('css')
    })

    it('falls back a non-numeric version to the current version', () => {
      const { document } = parseSandboxDocument(JSON.stringify({ js: 'x', version: 'bad' }))
      expect(document.version).toBe(SANDBOX_DOCUMENT_VERSION)
    })
  })

  describe('buildSandboxSrcdoc', () => {
    const doc = { html: '<h1>Hi</h1>', css: 'h1{color:red}', js: "console.log('x')" }

    it('composes html, css, and js into the srcdoc', () => {
      const srcdoc = buildSandboxSrcdoc(doc, { captureConsole: false })
      expect(srcdoc).toContain('<style>h1{color:red}</style>')
      expect(srcdoc).toContain('<h1>Hi</h1>')
      expect(srcdoc).toContain("<script>console.log('x')</script>")
      expect(srcdoc).toContain('<!DOCTYPE html>')
    })

    it('omits the console prelude when capture is off', () => {
      const srcdoc = buildSandboxSrcdoc(doc, { captureConsole: false })
      expect(srcdoc).not.toContain(SANDBOX_CONSOLE_CHANNEL)
    })

    it('injects the console prelude when capture is on', () => {
      const srcdoc = buildSandboxSrcdoc(doc, { captureConsole: true })
      expect(srcdoc).toContain(SANDBOX_CONSOLE_CHANNEL)
      // Prelude wraps console methods and posts to the parent.
      expect(srcdoc).toContain('parent.postMessage')
      expect(srcdoc).toContain("window.addEventListener('error'")
    })

    it('places the console prelude before the user script so it wraps console early', () => {
      const srcdoc = buildSandboxSrcdoc(doc, { captureConsole: true })
      const preludeIndex = srcdoc.indexOf('parent.postMessage')
      const userScriptIndex = srcdoc.indexOf("console.log('x')")
      expect(preludeIndex).toBeGreaterThanOrEqual(0)
      expect(userScriptIndex).toBeGreaterThan(preludeIndex)
    })

    it('handles missing panes without throwing', () => {
      expect(() => buildSandboxSrcdoc({ html: '', css: '', js: '' }, { captureConsole: true })).not.toThrow()
    })
  })
})
