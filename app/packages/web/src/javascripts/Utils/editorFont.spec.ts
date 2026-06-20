import {
  EDITOR_FONT_CSS_VAR,
  GOOGLE_FONT_PREFIX,
  applyEditorFont,
  getGoogleFontName,
  isGoogleFontValue,
  loadGoogleFont,
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

    it('quotes a google font name', () => {
      expect(resolveEditorFontFamily('google:Open Sans')).toBe("'Open Sans'")
    })

    it('returns null for a google value with a blank name', () => {
      expect(resolveEditorFontFamily('google:   ')).toBeNull()
    })

    it('passes a literal css font-family stack through unchanged', () => {
      expect(resolveEditorFontFamily('Georgia, serif')).toBe('Georgia, serif')
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

  describe('loadGoogleFont', () => {
    it('injects a single stylesheet link for a family name', () => {
      loadGoogleFont('Open Sans')
      const link = getFontLink()
      expect(link).not.toBeNull()
      expect(link?.rel).toBe('stylesheet')
      expect(link?.href).toContain('family=Open+Sans')
    })

    it('replaces (does not duplicate) the link when called with a new family', () => {
      loadGoogleFont('Open Sans')
      loadGoogleFont('Roboto')
      expect(document.querySelectorAll(`#${GOOGLE_FONT_LINK_ID}`)).toHaveLength(1)
      expect(getFontLink()?.href).toContain('family=Roboto')
    })

    it('removes the link when called with an empty / undefined name', () => {
      loadGoogleFont('Open Sans')
      loadGoogleFont(undefined)
      expect(getFontLink()).toBeNull()

      loadGoogleFont('Open Sans')
      loadGoogleFont('   ')
      expect(getFontLink()).toBeNull()
    })
  })

  describe('applyEditorFont', () => {
    const getCssVar = () => document.documentElement.style.getPropertyValue(EDITOR_FONT_CSS_VAR)

    it('sets the css variable to a quoted google font and adds the link', () => {
      applyEditorFont('google:Open Sans')
      expect(getCssVar()).toBe("'Open Sans'")
      expect(getFontLink()).not.toBeNull()
      expect(document.documentElement.classList.contains('monospace-font')).toBe(false)
    })

    it('sets the css variable to a literal font stack and removes any google link', () => {
      loadGoogleFont('Open Sans')
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
