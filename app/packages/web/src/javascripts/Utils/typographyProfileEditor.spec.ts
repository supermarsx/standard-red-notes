/**
 * @jest-environment jsdom
 *
 * Phase 3 popup style editor logic: sanitisation (CSP — unsafe values dropped)
 * and the edit → BlockStyle → setPreference round-trip (writing an edited block
 * back into the active profile, immutably).
 */
import { DEFAULT_TYPOGRAPHY_PROFILE, type TypographyProfile } from '@standardnotes/models'
import {
  isBlockStyleEmpty,
  sanitizeBlockStyle,
  setActiveProfileBlockStyle,
  setActiveProfileBlocks,
} from './typographyProfileEditor'

const makeProfile = (overrides: Partial<TypographyProfile> = {}): TypographyProfile => ({
  id: 'custom',
  name: 'Custom',
  isDefault: false,
  schemaVersion: 1,
  blocks: {},
  ...overrides,
})

describe('typographyProfileEditor', () => {
  describe('sanitizeBlockStyle', () => {
    it('keeps safe, non-empty values (trimmed)', () => {
      const clean = sanitizeBlockStyle({
        fontSize: ' 1.25rem ',
        color: 'var(--sn-stylekit-info-color)',
        lineHeight: '1.5',
      })
      expect(clean).toEqual({
        fontSize: '1.25rem',
        color: 'var(--sn-stylekit-info-color)',
        lineHeight: '1.5',
      })
    })

    it('drops empty / whitespace values (treated as "inherit")', () => {
      const clean = sanitizeBlockStyle({ fontSize: '', color: '   ', marginTop: '8px' })
      expect(clean).toEqual({ marginTop: '8px' })
    })

    it('drops CSP-dangerous values (url/@import/expression/js/structural)', () => {
      const clean = sanitizeBlockStyle({
        backgroundColor: 'url(https://evil.example/x.png)',
        color: 'red; } body { display:none',
        borderColor: 'expression(alert(1))',
        marginTop: 'javascript:alert(1)',
        fontSize: '1rem',
      })
      expect(clean).toEqual({ fontSize: '1rem' })
    })

    it('validates fontFamily through the vetted grammar (google: kept, url dropped)', () => {
      expect(sanitizeBlockStyle({ fontFamily: 'google:Inter' })).toEqual({ fontFamily: 'google:Inter' })
      expect(sanitizeBlockStyle({ fontFamily: 'Georgia, serif' })).toEqual({ fontFamily: 'Georgia, serif' })
      expect(sanitizeBlockStyle({ fontFamily: 'url(https://evil.example/f.woff)' })).toEqual({})
    })

    it('whitelists borderSide to the allowed enum', () => {
      expect(sanitizeBlockStyle({ borderSide: 'left' })).toEqual({ borderSide: 'left' })
      // An out-of-enum value is dropped.
      expect(sanitizeBlockStyle({ borderSide: 'diagonal' as never })).toEqual({})
    })

    it('isBlockStyleEmpty reports a fully-inherited style', () => {
      expect(isBlockStyleEmpty(sanitizeBlockStyle({ fontSize: '' }))).toBe(true)
      expect(isBlockStyleEmpty(sanitizeBlockStyle({ fontSize: '1rem' }))).toBe(false)
    })
  })

  describe('setActiveProfileBlockStyle (edit → BlockStyle → pref round-trip)', () => {
    const active = makeProfile({ id: 'a', isDefault: true, blocks: { paragraph: { lineHeight: '1' } } })
    const other = makeProfile({ id: 'b' })

    it('writes the edited (sanitised) block into the ACTIVE profile', () => {
      const updated = setActiveProfileBlockStyle([active, other], 'a', 'h1', {
        fontSize: '2rem',
        color: 'red',
        backgroundColor: 'url(https://evil.example/x.png)', // unsafe → dropped
      })
      const updatedActive = updated.find((p) => p.id === 'a')!
      expect(updatedActive.blocks.h1).toEqual({ fontSize: '2rem', color: 'red' })
      // Existing sibling block is preserved.
      expect(updatedActive.blocks.paragraph).toEqual({ lineHeight: '1' })
    })

    it('is immutable — the original profiles/blocks are untouched', () => {
      const input = [active, other]
      setActiveProfileBlockStyle(input, 'a', 'h1', { fontSize: '2rem' })
      expect(active.blocks.h1).toBeUndefined()
      expect(input[0]).toBe(active)
    })

    it('removes the block entry when the edit sanitises to empty (back to inherit)', () => {
      const withH1 = makeProfile({ id: 'a', isDefault: true, blocks: { h1: { fontSize: '2rem' } } })
      const updated = setActiveProfileBlockStyle([withH1], 'a', 'h1', { fontSize: '' })
      expect(updated[0].blocks.h1).toBeUndefined()
    })

    it('leaves non-active profiles untouched', () => {
      const updated = setActiveProfileBlockStyle([active, other], 'a', 'h1', { fontSize: '2rem' })
      expect(updated.find((p) => p.id === 'b')).toBe(other)
    })

    it('falls back to the Default profile when the list is empty', () => {
      const updated = setActiveProfileBlockStyle([], undefined, 'h1', { fontSize: '2rem' })
      expect(updated).toHaveLength(1)
      expect(updated[0].id).toBe(DEFAULT_TYPOGRAPHY_PROFILE.id)
      expect(updated[0].blocks.h1).toEqual({ fontSize: '2rem' })
    })
  })

  describe('setActiveProfileBlocks (whole-map save)', () => {
    it('replaces the active profile blocks, sanitising each and dropping empties', () => {
      const active = makeProfile({ id: 'a', isDefault: true, blocks: { paragraph: { lineHeight: '1' } } })
      const updated = setActiveProfileBlocks([active], 'a', {
        h1: { fontSize: '2rem', backgroundColor: 'url(https://evil.example/x.png)' },
        h2: { fontSize: '' }, // empties out → omitted
      })
      const updatedActive = updated[0]
      expect(updatedActive.blocks.h1).toEqual({ fontSize: '2rem' })
      expect(updatedActive.blocks.h2).toBeUndefined()
      // The whole map was replaced, so the old paragraph entry is gone.
      expect(updatedActive.blocks.paragraph).toBeUndefined()
    })
  })
})
