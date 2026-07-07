/**
 * @jest-environment jsdom
 */
import { DEFAULT_TYPOGRAPHY_PROFILE, type TypographyProfile } from '@standardnotes/models'
import {
  TYPOGRAPHY_SCOPE_SELECTOR,
  TYPOGRAPHY_STYLE_ELEMENT_ID,
  applyTypographyProfile,
  blockStyleToCss,
  blockStyleToDeclarations,
  isSafeCssValue,
  resolveActiveTypographyProfile,
} from './typographyProfiles'

const makeProfile = (overrides: Partial<TypographyProfile> = {}): TypographyProfile => ({
  id: 'custom',
  name: 'Custom',
  isDefault: false,
  schemaVersion: 1,
  blocks: {},
  ...overrides,
})

describe('typographyProfiles', () => {
  describe('isSafeCssValue', () => {
    it('accepts plain lengths, colours and font stacks', () => {
      expect(isSafeCssValue('1.5')).toBe(true)
      expect(isSafeCssValue('16px')).toBe(true)
      expect(isSafeCssValue('var(--sn-stylekit-info-color)')).toBe(true)
      expect(isSafeCssValue('Georgia, serif')).toBe(true)
    })

    it('rejects empty / undefined values', () => {
      expect(isSafeCssValue(undefined)).toBe(false)
      expect(isSafeCssValue('   ')).toBe(false)
    })

    it('rejects CSP-dangerous values (url/@import/expression/js/structural)', () => {
      expect(isSafeCssValue('url(https://evil.example/x.png)')).toBe(false)
      expect(isSafeCssValue('@import "http://evil"')).toBe(false)
      expect(isSafeCssValue('expression(alert(1))')).toBe(false)
      expect(isSafeCssValue('javascript:alert(1)')).toBe(false)
      expect(isSafeCssValue('red; } body { display:none')).toBe(false)
      expect(isSafeCssValue('red /* comment */')).toBe(false)
    })
  })

  describe('blockStyleToDeclarations', () => {
    it('emits declarations for set, safe properties only', () => {
      const decls = blockStyleToDeclarations({
        lineHeight: '1.75',
        marginTop: '8px',
        color: 'var(--sn-stylekit-info-color)',
        fontSize: undefined,
      })
      expect(decls).toContain('line-height: 1.75')
      expect(decls).toContain('margin-top: 8px')
      expect(decls).toContain('color: var(--sn-stylekit-info-color)')
      expect(decls.some((d) => d.startsWith('font-size'))).toBe(false)
    })

    it('drops properties whose value is CSP-unsafe', () => {
      const decls = blockStyleToDeclarations({
        backgroundColor: 'url(https://evil.example/x.png)',
        color: 'red',
      })
      expect(decls).toEqual(['color: red'])
    })

    it('maps borderSide to the correct edge-specific properties', () => {
      const decls = blockStyleToDeclarations({
        borderSide: 'left',
        borderColor: 'blue',
        borderWidth: '4px',
        borderStyle: 'solid',
      })
      expect(decls).toContain('border-left-color: blue')
      expect(decls).toContain('border-left-width: 4px')
      expect(decls).toContain('border-left-style: solid')
    })

    it("resolves a google: fontFamily through the vetted grammar", () => {
      const decls = blockStyleToDeclarations({ fontFamily: 'google:Inter' })
      expect(decls).toContain("font-family: 'Inter'")
    })
  })

  describe('blockStyleToCss', () => {
    it('scopes each block rule under the editor root (low specificity, no !important)', () => {
      const css = blockStyleToCss(makeProfile({ blocks: { paragraph: { lineHeight: '2', marginTop: '12px' } } }))
      expect(css).toContain(`${TYPOGRAPHY_SCOPE_SELECTOR} .Lexical__paragraph {`)
      expect(css).toContain('line-height: 2')
      expect(css).toContain('margin-top: 12px')
      expect(css).not.toContain('!important')
    })

    it('emits a ::marker rule when markerColor is set', () => {
      const css = blockStyleToCss(makeProfile({ blocks: { bulletList: { markerColor: 'red', listMarkerStyle: 'square' } } }))
      expect(css).toContain('list-style-type: square')
      expect(css).toContain(`${TYPOGRAPHY_SCOPE_SELECTOR} .Lexical__ul ::marker {`)
      expect(css).toContain('color: red')
    })

    it('expands numberedList across all ol depth classes', () => {
      const css = blockStyleToCss(makeProfile({ blocks: { numberedList: { color: 'green' } } }))
      expect(css).toContain(`${TYPOGRAPHY_SCOPE_SELECTOR} .Lexical__ol1`)
      expect(css).toContain('.Lexical__ol5')
    })

    it('targets callouts via the data-attribute selector', () => {
      const css = blockStyleToCss(makeProfile({ blocks: { callout: { borderRadius: '8px' } } }))
      expect(css).toContain(`${TYPOGRAPHY_SCOPE_SELECTOR} [data-callout-block="true"]`)
    })

    it('emits nothing for a block whose style has no safe declarations', () => {
      const css = blockStyleToCss(makeProfile({ blocks: { paragraph: {} } }))
      expect(css).toBe('')
    })

    describe('DEFAULT profile == current editor.scss look', () => {
      const css = blockStyleToCss(DEFAULT_TYPOGRAPHY_PROFILE)

      it('reproduces the heading sizes/weights/colour', () => {
        expect(css).toContain(`${TYPOGRAPHY_SCOPE_SELECTOR} .Lexical__h1 {`)
        expect(css).toContain('font-size: 1.625rem')
        expect(css).toContain('font-size: 1.375rem') // h2
        expect(css).toContain('font-size: 1.1875rem') // h3
        expect(css).toContain('font-weight: 700')
        expect(css).toContain('color: var(--sn-stylekit-editor-foreground-color)')
      })

      it('reproduces the quote left border and colour', () => {
        expect(css).toContain(`${TYPOGRAPHY_SCOPE_SELECTOR} .Lexical__quote {`)
        expect(css).toContain('border-left-color: var(--sn-stylekit-passive-color-1)')
        expect(css).toContain('border-left-width: 4px')
        expect(css).toContain('border-left-style: solid')
        expect(css).toContain('padding-left: 16px')
        expect(css).toContain('margin-left: 20px')
      })

      it('reproduces the code block box', () => {
        expect(css).toContain('background-color: var(--sn-stylekit-contrast-background-color)')
        expect(css).toContain('border-radius: 0.25rem')
      })

      it('never uses !important and never smuggles url()/@import', () => {
        expect(css).not.toContain('!important')
        expect(css).not.toMatch(/url\(|@import/)
      })
    })

    it('a non-default profile changes line-height / margins vs the default', () => {
      const custom = makeProfile({
        blocks: { paragraph: { lineHeight: '2.5', marginTop: '40px', marginBottom: '40px' } },
      })
      const customCss = blockStyleToCss(custom)
      const defaultCss = blockStyleToCss(DEFAULT_TYPOGRAPHY_PROFILE)
      expect(customCss).toContain('line-height: 2.5')
      expect(customCss).toContain('margin-top: 40px')
      expect(defaultCss).not.toContain('line-height: 2.5')
      expect(defaultCss).not.toContain('margin-top: 40px')
    })
  })

  describe('applyTypographyProfile (head injection)', () => {
    afterEach(() => {
      document.getElementById(TYPOGRAPHY_STYLE_ELEMENT_ID)?.remove()
    })

    it('injects a single <style> element on document.head', () => {
      applyTypographyProfile(makeProfile({ blocks: { paragraph: { lineHeight: '1.9' } } }))
      const el = document.getElementById(TYPOGRAPHY_STYLE_ELEMENT_ID)
      expect(el).not.toBeNull()
      expect(el?.tagName).toBe('STYLE')
      expect(el?.parentElement).toBe(document.head)
      expect(el?.textContent).toContain('line-height: 1.9')
    })

    it('updates the same element (O(1)) on re-apply — never a second one', () => {
      applyTypographyProfile(makeProfile({ blocks: { paragraph: { lineHeight: '1.9' } } }))
      applyTypographyProfile(makeProfile({ blocks: { paragraph: { lineHeight: '2.2' } } }))
      const all = document.querySelectorAll(`#${TYPOGRAPHY_STYLE_ELEMENT_ID}`)
      expect(all.length).toBe(1)
      expect(all[0].textContent).toContain('line-height: 2.2')
      expect(all[0].textContent).not.toContain('line-height: 1.9')
    })

    it('removes the element when given null', () => {
      applyTypographyProfile(makeProfile({ blocks: { paragraph: { lineHeight: '1.9' } } }))
      applyTypographyProfile(null)
      expect(document.getElementById(TYPOGRAPHY_STYLE_ELEMENT_ID)).toBeNull()
    })

    it('applying the DEFAULT profile injects the equivalent-to-current CSS', () => {
      applyTypographyProfile(DEFAULT_TYPOGRAPHY_PROFILE)
      const el = document.getElementById(TYPOGRAPHY_STYLE_ELEMENT_ID)
      expect(el?.textContent).toContain('font-size: 1.625rem')
      expect(el?.textContent).not.toContain('!important')
    })
  })

  describe('resolveActiveTypographyProfile', () => {
    const a = makeProfile({ id: 'a' })
    const def = makeProfile({ id: 'default', isDefault: true })

    it('returns the profile matching the active id', () => {
      expect(resolveActiveTypographyProfile([a, def], 'a')).toBe(a)
    })

    it('falls back to the default profile when the id is missing', () => {
      expect(resolveActiveTypographyProfile([a, def], 'nonexistent')).toBe(def)
    })

    it('falls back to the first profile when none is flagged default', () => {
      const b = makeProfile({ id: 'b' })
      expect(resolveActiveTypographyProfile([a, b], 'nope')).toBe(a)
    })

    it('returns null for empty / invalid input', () => {
      expect(resolveActiveTypographyProfile([], 'a')).toBeNull()
      expect(resolveActiveTypographyProfile(undefined, 'a')).toBeNull()
    })
  })
})
