import {
  BundledEditorFonts,
  EDITOR_FONT_CSS_VAR,
  GOOGLE_FONT_PREFIX,
  applyEditorFont,
  findBundledEditorFont,
  getGoogleFontName,
  getPrimaryFontFamily,
  isGoogleFontValue,
  loadEditorFontFaces,
  makeGoogleFontValue,
  resolveEditorFontFamily,
} from './editorFont'

describe('editorFont pure helpers', () => {
  describe('isGoogleFontValue', () => {
    it('detects the google: prefix', () => {
      expect(isGoogleFontValue('google:Inter')).toBe(true)
    })

    it('is false for non-prefixed values', () => {
      expect(isGoogleFontValue('Inter')).toBe(false)
      expect(isGoogleFontValue('')).toBe(false)
      expect(isGoogleFontValue('serif')).toBe(false)
    })
  })

  describe('getGoogleFontName', () => {
    it('strips the prefix and trims', () => {
      expect(getGoogleFontName('google:  Open Sans  ')).toBe('Open Sans')
    })

    it('returns empty string when value is not a google font', () => {
      expect(getGoogleFontName('Inter')).toBe('')
    })
  })

  describe('makeGoogleFontValue', () => {
    it('prefixes and trims the family name', () => {
      expect(makeGoogleFontValue('  Roboto  ')).toBe(`${GOOGLE_FONT_PREFIX}Roboto`)
    })

    it('round-trips with getGoogleFontName', () => {
      expect(getGoogleFontName(makeGoogleFontValue('Lato'))).toBe('Lato')
    })
  })

  describe('resolveEditorFontFamily', () => {
    it('returns null for empty / undefined (theme default)', () => {
      expect(resolveEditorFontFamily('')).toBeNull()
      expect(resolveEditorFontFamily(undefined)).toBeNull()
    })

    it('maps a legacy google: value onto the bundled stack of the same name', () => {
      // 'Open Sans' is in the bundle, so the stored legacy value keeps working
      // AND gains the fallback it never had.
      expect(resolveEditorFontFamily('google:Open Sans')).toBe("'Open Sans', sans-serif")
    })

    it('matches a legacy google: value case-insensitively', () => {
      expect(resolveEditorFontFamily('google:open sans')).toBe("'Open Sans', sans-serif")
    })

    it('maps a legacy google: value we do NOT bundle to a quoted family plus a generic', () => {
      // The whole defect: this used to emit a bare `'Chivo'` and land on the
      // browser default when the (CSP-refused) remote stylesheet never arrived.
      expect(findBundledEditorFont('Chivo')).toBeUndefined()
      expect(resolveEditorFontFamily('google:Chivo')).toBe("'Chivo', sans-serif")
    })

    it('returns null for a google value with a blank name', () => {
      expect(resolveEditorFontFamily('google:   ')).toBeNull()
    })

    it('passes a literal css font-family stack through unchanged', () => {
      expect(resolveEditorFontFamily('Georgia, serif')).toBe('Georgia, serif')
    })

    it('passes a var() reference through unchanged', () => {
      expect(resolveEditorFontFamily('var(--sn-stylekit-monospace-font)')).toBe('var(--sn-stylekit-monospace-font)')
    })

    it('leaves a generic family keyword alone rather than quoting it', () => {
      expect(resolveEditorFontFamily('serif')).toBe('serif')
      expect(resolveEditorFontFamily('monospace')).toBe('monospace')
    })

    it('gives a bare local font name a generic fallback', () => {
      expect(resolveEditorFontFamily('Helvetica Neue')).toBe("'Helvetica Neue', sans-serif")
    })

    it('resolves every bundled family to a stack that names a generic fallback', () => {
      expect(BundledEditorFonts.length).toBeGreaterThan(0)
      for (const font of BundledEditorFonts) {
        const resolved = resolveEditorFontFamily(font.name)
        expect(resolved).not.toBeNull()
        // A stack, not a bare family: the regression this whole change fixes.
        expect(resolved).toMatch(/,\s*(sans-serif|serif|monospace|cursive)$/)
      }
    })
  })

  describe('getPrimaryFontFamily', () => {
    it('reads the first family out of a stack, unquoted', () => {
      expect(getPrimaryFontFamily("'Inter', sans-serif")).toBe('Inter')
    })

    it('reads the family out of a legacy google: value', () => {
      expect(getPrimaryFontFamily('google:Open Sans')).toBe('Open Sans')
    })

    it('returns empty for an empty value or a var() reference', () => {
      expect(getPrimaryFontFamily('')).toBe('')
      expect(getPrimaryFontFamily(undefined)).toBe('')
      expect(getPrimaryFontFamily('var(--sn-stylekit-sans-serif-font)')).toBe('')
    })
  })

  describe('findBundledEditorFont', () => {
    it('finds a bundled family regardless of case and padding', () => {
      expect(findBundledEditorFont('  jetbrains mono  ')?.name).toBe('JetBrains Mono')
    })

    it('returns undefined for a family we do not ship', () => {
      expect(findBundledEditorFont('Comic Sans MS')).toBeUndefined()
      expect(findBundledEditorFont('')).toBeUndefined()
    })

    it('exposes only self-hosted families, never the system/generic entries', () => {
      expect(findBundledEditorFont('Arial')).toBeUndefined()
      expect(BundledEditorFonts.every((font) => font.bundled === true)).toBe(true)
    })
  })
})

describe('editorFont DOM helpers (jsdom)', () => {
  const GOOGLE_FONT_LINK_ID = 'sn-editor-google-font'

  beforeEach(() => {
    document.head.innerHTML = ''
    document.documentElement.removeAttribute('style')
    document.documentElement.className = ''
  })

  const getFontLink = () => document.getElementById(GOOGLE_FONT_LINK_ID) as HTMLLinkElement | null

  /** Stand in for a legacy link injected by the pre-bundled-fonts build. */
  const injectLegacyGoogleLink = () => {
    const link = document.createElement('link')
    link.id = GOOGLE_FONT_LINK_ID
    link.rel = 'stylesheet'
    link.href = 'https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap'
    document.head.appendChild(link)
  }

  /**
   * jsdom implements no `document.fonts`, so the CSS Font Loading API is faked.
   * Only `load` is needed; it records the font shorthands requested.
   */
  const installFakeFontFaceSet = () => {
    const requested: string[] = []
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        load: (font: string) => {
          requested.push(font)
          return Promise.resolve([])
        },
      },
    })
    return requested
  }

  const removeFakeFontFaceSet = () => {
    Reflect.deleteProperty(document, 'fonts')
  }

  describe('loadEditorFontFaces', () => {
    afterEach(removeFakeFontFaceSet)

    it('requests every shipped weight of a bundled family from our own origin', () => {
      const requested = installFakeFontFaceSet()
      loadEditorFontFaces("'Open Sans', sans-serif")

      const openSans = findBundledEditorFont('Open Sans')
      expect(openSans).toBeDefined()
      expect(requested).toHaveLength(openSans?.weights.length ?? 0)
      // A real font shorthand `<weight> <size> <family>`, which the Font
      // Loading API would otherwise reject.
      expect(requested).toContain("400 1em 'Open Sans'")
      expect(requested.every((font) => /^\d{3} 1em 'Open Sans'$/.test(font))).toBe(true)
    })

    it('resolves a legacy google: value to the same bundled faces', () => {
      const requested = installFakeFontFaceSet()
      loadEditorFontFaces('google:Open Sans')
      expect(requested).toContain("400 1em 'Open Sans'")
    })

    it('requests nothing for a family we do not bundle', () => {
      const requested = installFakeFontFaceSet()
      loadEditorFontFaces('Helvetica Neue')
      loadEditorFontFaces('google:Chivo')
      loadEditorFontFaces('')
      loadEditorFontFaces(undefined)
      expect(requested).toEqual([])
    })

    it('never requests a stylesheet from a third party, and clears a legacy link', () => {
      installFakeFontFaceSet()
      injectLegacyGoogleLink()
      expect(getFontLink()).not.toBeNull()

      loadEditorFontFaces('google:Open Sans')

      expect(getFontLink()).toBeNull()
      expect(document.head.innerHTML).not.toContain('fonts.googleapis.com')
      expect(document.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(0)
    })

    it('is a no-op where the Font Loading API is absent (jsdom, SSR)', () => {
      removeFakeFontFaceSet()
      expect(() => loadEditorFontFaces("'Open Sans', sans-serif")).not.toThrow()
    })
  })

  describe('applyEditorFont', () => {
    const getCssVar = () => document.documentElement.style.getPropertyValue(EDITOR_FONT_CSS_VAR)

    it('sets the css variable to the bundled stack for a legacy google value, with no link', () => {
      applyEditorFont('google:Open Sans')
      expect(getCssVar()).toBe("'Open Sans', sans-serif")
      expect(getFontLink()).toBeNull()
      expect(document.documentElement.classList.contains('monospace-font')).toBe(false)
    })

    it('sets the css variable to a literal font stack and removes any legacy google link', () => {
      injectLegacyGoogleLink()
      applyEditorFont('Georgia, serif')
      expect(getCssVar()).toBe('Georgia, serif')
      expect(getFontLink()).toBeNull()
    })

    it('falls back to the sans-serif stack when no override is set', () => {
      applyEditorFont('')
      expect(getCssVar()).toBe('var(--sn-stylekit-sans-serif-font)')
      expect(document.documentElement.classList.contains('monospace-font')).toBe(false)
    })

    it('falls back to the monospace stack and toggles the class when monospaceFallback is set', () => {
      applyEditorFont('', true)
      expect(getCssVar()).toBe('var(--sn-stylekit-monospace-font)')
      expect(document.documentElement.classList.contains('monospace-font')).toBe(true)
    })
  })
})
