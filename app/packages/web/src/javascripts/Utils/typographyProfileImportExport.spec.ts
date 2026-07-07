/**
 * @jest-environment jsdom
 *
 * Phase 4 import / export: profile → JSON export, and JSON → SAFE profile import
 * (schemaVersion validation, per-block sanitisation of untrusted CSS, fresh id,
 * isDefault forced off).
 */
import { DEFAULT_TYPOGRAPHY_PROFILE, TYPOGRAPHY_PROFILE_SCHEMA_VERSION, type TypographyProfile } from '@standardnotes/models'
import {
  exportFileNameForProfile,
  parseImportedProfile,
  profileToExportJson,
} from './typographyProfileImportExport'

const makeProfile = (overrides: Partial<TypographyProfile> = {}): TypographyProfile => ({
  id: 'custom',
  name: 'Custom',
  isDefault: false,
  schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
  blocks: {},
  ...overrides,
})

describe('typographyProfileImportExport', () => {
  describe('export', () => {
    it('serialises a profile to pretty JSON that round-trips through import', () => {
      const profile = makeProfile({ name: 'Serif', blocks: { h1: { fontSize: '2rem' } } })
      const json = profileToExportJson(profile)
      expect(JSON.parse(json)).toEqual(profile)

      const result = parseImportedProfile(json)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.profile.name).toBe('Serif')
        expect(result.profile.blocks.h1).toEqual({ fontSize: '2rem' })
      }
    })

    it('builds a filesystem-safe filename from the profile name', () => {
      expect(exportFileNameForProfile(makeProfile({ name: 'My  Reading! Profile' }))).toBe(
        'my-reading-profile.typography.json',
      )
      expect(exportFileNameForProfile(makeProfile({ name: '   ' }))).toBe('profile.typography.json')
    })
  })

  describe('import validation', () => {
    it('rejects non-JSON and non-object payloads', () => {
      expect(parseImportedProfile('not json').ok).toBe(false)
      expect(parseImportedProfile('[]').ok).toBe(false)
      expect(parseImportedProfile('42').ok).toBe(false)
    })

    it('rejects a missing / invalid schemaVersion', () => {
      expect(parseImportedProfile(JSON.stringify({ name: 'X', blocks: {} })).ok).toBe(false)
      expect(parseImportedProfile(JSON.stringify({ name: 'X', schemaVersion: 'one', blocks: {} })).ok).toBe(false)
    })

    it('rejects a newer (unsupported) schemaVersion', () => {
      const result = parseImportedProfile(
        JSON.stringify({ name: 'X', schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION + 1, blocks: {} }),
      )
      expect(result.ok).toBe(false)
    })

    it('assigns a FRESH id and forces isDefault off (an import cannot hijack Default)', () => {
      const result = parseImportedProfile(
        JSON.stringify({
          id: DEFAULT_TYPOGRAPHY_PROFILE.id,
          name: 'Evil',
          isDefault: true,
          schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
          blocks: {},
        }),
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.profile.id).not.toBe(DEFAULT_TYPOGRAPHY_PROFILE.id)
        expect(result.profile.isDefault).toBe(false)
      }
    })

    it('sanitises untrusted CSS — url()/@import/expression and unknown keys are stripped', () => {
      const result = parseImportedProfile(
        JSON.stringify({
          name: 'Sneaky',
          schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
          blocks: {
            h1: {
              fontSize: '2rem',
              backgroundColor: 'url(https://evil.example/x.png)',
              color: 'red; } body { display:none',
              somethingUnknown: 'whatever',
            },
            paragraph: { fontFamily: 'url(https://evil.example/f.woff)' }, // empties out → dropped
          },
        }),
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.profile.blocks.h1).toEqual({ fontSize: '2rem' })
        expect(result.profile.blocks.paragraph).toBeUndefined()
      }
    })

    it('falls back to a default name when the imported name is missing/blank', () => {
      const result = parseImportedProfile(
        JSON.stringify({ schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION, blocks: {} }),
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.profile.name).toBe('Imported profile')
      }
    })
  })
})
