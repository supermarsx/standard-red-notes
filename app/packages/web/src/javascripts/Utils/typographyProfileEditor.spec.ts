/**
 * @jest-environment jsdom
 *
 * Phase 3 popup style editor logic: sanitisation (CSP — unsafe values dropped)
 * and the edit → BlockStyle → setPreference round-trip (writing an edited block
 * back into the active profile, immutably).
 */
import { DEFAULT_TYPOGRAPHY_PROFILE, DEFAULT_TYPOGRAPHY_PROFILE_ID, type TypographyProfile } from '@standardnotes/models'
import {
  canDeleteProfile,
  createProfile,
  deleteProfile,
  duplicateProfile,
  isBlockStyleEmpty,
  renameProfile,
  sanitizeBlockStyle,
  setActiveProfileBlockStyle,
  setActiveProfileBlocks,
  setDefaultProfile,
  setProfileBlocks,
  uniqueProfileName,
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

  describe('setProfileBlocks (edit ANY profile by id — P4 generalisation)', () => {
    it('writes into the targeted profile, leaving the active/others untouched', () => {
      const active = makeProfile({ id: 'a', isDefault: true, blocks: { paragraph: { lineHeight: '1' } } })
      const other = makeProfile({ id: 'b', blocks: { h1: { fontSize: '1rem' } } })
      // Active is 'a', but we target 'b'.
      const updated = setProfileBlocks([active, other], 'b', { h2: { fontSize: '2rem' } })
      expect(updated.find((p) => p.id === 'b')!.blocks).toEqual({ h2: { fontSize: '2rem' } })
      // Active profile untouched (identity preserved).
      expect(updated.find((p) => p.id === 'a')).toBe(active)
    })

    it('sanitises each block and is a no-op for an unknown id', () => {
      const a = makeProfile({ id: 'a', isDefault: true })
      const updated = setProfileBlocks([a], 'nope', { h1: { fontSize: '2rem' } })
      expect(updated[0]).toBe(a)
    })
  })

  describe('profile CRUD (P4)', () => {
    const defaultProfile = makeProfile({ id: DEFAULT_TYPOGRAPHY_PROFILE_ID, name: 'Default', isDefault: true })

    describe('uniqueProfileName', () => {
      it('returns the base name when free, else the first "base N"', () => {
        const list = [makeProfile({ id: '1', name: 'Reading' }), makeProfile({ id: '2', name: 'Reading 2' })]
        expect(uniqueProfileName(list, 'Writing')).toBe('Writing')
        expect(uniqueProfileName(list, 'Reading')).toBe('Reading 3')
      })
    })

    describe('createProfile', () => {
      it('clones the Default blocks under a fresh id + unique name, never isDefault', () => {
        const { profiles, created } = createProfile([defaultProfile])
        expect(profiles).toHaveLength(2)
        expect(created.isDefault).toBe(false)
        expect(created.id).not.toBe(DEFAULT_TYPOGRAPHY_PROFILE_ID)
        expect(created.blocks).toEqual(DEFAULT_TYPOGRAPHY_PROFILE.blocks)
        // Deep clone — not the same object reference.
        expect(created.blocks).not.toBe(DEFAULT_TYPOGRAPHY_PROFILE.blocks)
      })
    })

    describe('duplicateProfile', () => {
      it('deep-copies a profile under a new id and a "… copy" name', () => {
        const source = makeProfile({ id: 's', name: 'Serif', blocks: { h1: { fontSize: '2rem' } } })
        const { profiles, created } = duplicateProfile([defaultProfile, source], 's')
        expect(profiles).toHaveLength(3)
        expect(created.name).toBe('Serif copy')
        expect(created.id).not.toBe('s')
        expect(created.isDefault).toBe(false)
        expect(created.blocks).toEqual({ h1: { fontSize: '2rem' } })
        expect(created.blocks.h1).not.toBe(source.blocks.h1)
      })
    })

    describe('renameProfile', () => {
      it('renames the target and rejects empty names', () => {
        const p = makeProfile({ id: 'x', name: 'Old' })
        expect(renameProfile([p], 'x', ' New ')[0].name).toBe('New')
        expect(renameProfile([p], 'x', '   ')[0].name).toBe('Old')
      })
    })

    describe('setDefaultProfile (single winner)', () => {
      it('makes exactly one profile default', () => {
        const a = makeProfile({ id: 'a', isDefault: true })
        const b = makeProfile({ id: 'b', isDefault: false })
        const updated = setDefaultProfile([a, b], 'b')
        expect(updated.filter((p) => p.isDefault).map((p) => p.id)).toEqual(['b'])
      })

      it('is a no-op for an unknown id (never zero defaults)', () => {
        const a = makeProfile({ id: 'a', isDefault: true })
        expect(setDefaultProfile([a], 'nope')).toEqual([a])
      })
    })

    describe('canDeleteProfile / deleteProfile guards', () => {
      it('cannot delete the built-in Default or the last remaining profile', () => {
        const custom = makeProfile({ id: 'c', name: 'Custom' })
        expect(canDeleteProfile([defaultProfile, custom], DEFAULT_TYPOGRAPHY_PROFILE_ID)).toBe(false)
        expect(canDeleteProfile([custom], 'c')).toBe(false)
        expect(canDeleteProfile([defaultProfile, custom], 'c')).toBe(true)

        // deleteProfile honours the guards (returns inputs untouched).
        const deleteDefault = deleteProfile([defaultProfile, custom], 'c', DEFAULT_TYPOGRAPHY_PROFILE_ID)
        expect(deleteDefault.profiles).toHaveLength(2)
        const deleteLast = deleteProfile([custom], 'c', 'c')
        expect(deleteLast.profiles).toHaveLength(1)
      })

      it('deleting a non-active profile keeps the active id', () => {
        const custom = makeProfile({ id: 'c' })
        const { profiles, activeId } = deleteProfile([defaultProfile, custom], DEFAULT_TYPOGRAPHY_PROFILE_ID, 'c')
        expect(profiles.map((p) => p.id)).toEqual([DEFAULT_TYPOGRAPHY_PROFILE_ID])
        expect(activeId).toBe(DEFAULT_TYPOGRAPHY_PROFILE_ID)
      })

      it('deleting the ACTIVE profile reassigns active to the remaining default', () => {
        const custom = makeProfile({ id: 'c', name: 'Custom' })
        const { profiles, activeId } = deleteProfile([defaultProfile, custom], 'c', 'c')
        expect(profiles.map((p) => p.id)).toEqual([DEFAULT_TYPOGRAPHY_PROFILE_ID])
        expect(activeId).toBe(DEFAULT_TYPOGRAPHY_PROFILE_ID)
      })
    })
  })
})
