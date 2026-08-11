import {
  SANDBOX_DOCUMENT_VERSION,
  SANDBOX_CONSOLE_CHANNEL,
  SANDBOX_CONSOLE_LIMIT_NOTICE,
  SANDBOX_CONSOLE_MAX_ENTRIES,
  SANDBOX_CONSOLE_MAX_MESSAGE_LENGTH,
  SANDBOX_RUN_CHANNEL,
  SANDBOX_RUN_MAX_PAYLOAD_BYTES,
  SANDBOX_RUN_PAYLOAD_LIMIT_MESSAGE,
  SANDBOX_CONSOLE_TRUNCATION_SUFFIX,
  SandboxDocument,
  buildSandboxRunPayload,
  claimSandboxRunDelivery,
  createEmptySandboxDocument,
  createJsSandboxStarter,
  createWebSandboxStarter,
  createSandboxRunNonce,
  isSandboxRunPayloadWithinLimit,
  normalizeSandboxConsoleEntry,
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
      const { document, recovered } = parseSandboxDocument(JSON.stringify({ html: '<p>ok</p>', css: 42, js: null }))
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

  describe('buildSandboxRunPayload', () => {
    const doc = { html: '<h1>Hi</h1>', css: 'h1{color:red}', js: "console.log('x')" }
    const nonce = '0123456789abcdef0123456789abcdef'

    it('passes user content as data to the fixed runner', () => {
      const payload = buildSandboxRunPayload(doc, { captureConsole: false, nonce })
      expect(payload).toEqual({
        channel: SANDBOX_RUN_CHANNEL,
        nonce,
        document: doc,
        captureConsole: false,
      })
    })

    it('requests console capture without embedding the console transport in user code', () => {
      const payload = buildSandboxRunPayload(doc, { captureConsole: true, nonce })
      expect(payload.captureConsole).toBe(true)
      expect(JSON.stringify(payload.document)).not.toContain(SANDBOX_CONSOLE_CHANNEL)
    })

    it('handles missing panes without throwing', () => {
      expect(() => buildSandboxRunPayload({ html: '', css: '', js: '' }, { captureConsole: true, nonce })).not.toThrow()
    })
  })

  describe('run payload availability limit', () => {
    it('accepts exactly 1 MiB of aggregate UTF-8 content', () => {
      expect(isSandboxRunPayloadWithinLimit({ html: 'a'.repeat(SANDBOX_RUN_MAX_PAYLOAD_BYTES), css: '', js: '' })).toBe(
        true,
      )
    })

    it('counts multibyte content and rejects one byte beyond the aggregate limit', () => {
      const emojiBytes = 4
      const exactEmojiCount = SANDBOX_RUN_MAX_PAYLOAD_BYTES / emojiBytes
      expect(isSandboxRunPayloadWithinLimit({ html: '😀'.repeat(exactEmojiCount), css: '', js: '' })).toBe(true)
      expect(isSandboxRunPayloadWithinLimit({ html: '😀'.repeat(exactEmojiCount), css: '', js: 'x' })).toBe(false)
      expect(SANDBOX_RUN_PAYLOAD_LIMIT_MESSAGE.length).toBeLessThan(200)
    })
  })

  describe('one-shot frame delivery', () => {
    it('uses a fresh hexadecimal nonce and refuses a second load for that nonce', () => {
      const nonce = createSandboxRunNonce()
      const delivery = { current: undefined as string | undefined }

      expect(nonce).toMatch(/^[a-f0-9]{32}$/)
      expect(claimSandboxRunDelivery(delivery, nonce)).toBe(true)
      expect(claimSandboxRunDelivery(delivery, nonce)).toBe(false)
      expect(claimSandboxRunDelivery(delivery, `${nonce}-next`)).toBe(true)
    })
  })

  describe('console output limits', () => {
    it('truncates an oversized string to the exact parent-state limit', () => {
      const entry = normalizeSandboxConsoleEntry(
        { level: 'error', message: 'x'.repeat(SANDBOX_CONSOLE_MAX_MESSAGE_LENGTH + 100) },
        0,
      )

      expect(entry?.level).toBe('error')
      expect(entry?.message).toHaveLength(SANDBOX_CONSOLE_MAX_MESSAGE_LENGTH)
      expect(entry?.message.endsWith(SANDBOX_CONSOLE_TRUNCATION_SUFFIX)).toBe(true)
    })

    it('uses the final retained slot for one deterministic drop notice', () => {
      expect(
        normalizeSandboxConsoleEntry(
          { level: 'log', message: 'last visible message' },
          SANDBOX_CONSOLE_MAX_ENTRIES - 2,
        ),
      ).toEqual({ level: 'log', message: 'last visible message' })
      expect(
        normalizeSandboxConsoleEntry(
          { level: 'error', message: 'first dropped message' },
          SANDBOX_CONSOLE_MAX_ENTRIES - 1,
        ),
      ).toEqual({ level: 'warn', message: SANDBOX_CONSOLE_LIMIT_NOTICE })
      expect(
        normalizeSandboxConsoleEntry({ level: 'log', message: 'also dropped' }, SANDBOX_CONSOLE_MAX_ENTRIES),
      ).toBeUndefined()
    })

    it('rejects non-string payloads instead of coercing untrusted data', () => {
      expect(normalizeSandboxConsoleEntry({ level: 'log', message: { large: true } }, 0)).toBeUndefined()
    })
  })
})
