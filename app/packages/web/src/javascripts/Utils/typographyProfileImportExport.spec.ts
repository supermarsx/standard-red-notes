/**
 * @jest-environment jsdom
 *
 * Typography profile import/export: profile → JSON export, and JSON → SAFE profile import
 * (schemaVersion validation, per-block sanitisation of untrusted CSS, fresh id,
 * isDefault forced off).
 */
import {
  DEFAULT_TYPOGRAPHY_PROFILE,
  TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
  type BlockTypeKey,
  type TypographyProfile,
} from '@standardnotes/models'
import {
  BUNDLE_EXPORT_FILE_NAME,
  buildFullSelection,
  bundleToExportJson,
  computeSanitizationDiff,
  countSelectedBlocks,
  exportFileNameForProfile,
  parseImportedBundle,
  parseImportedProfile,
  pickProfileBlocks,
  profileToExportJson,
  resolveImport,
  selectFromBundle,
  serializeProfilesForExport,
  setBlockSelected,
  setProfileSelected,
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

  describe('lossless Default round-trip (BLOCK_KEYS completeness regression)', () => {
    it('exports the Default profile and re-imports it with ALL blocks intact — incl. h4/h5', () => {
      // FALSE-GREEN GUARD: the original incomplete BLOCK_KEYS omitted h4/h5, so
      // this exact assertion FAILED (h4/h5 silently dropped on re-import). It only
      // passes once the block catalog is complete.
      const json = profileToExportJson(DEFAULT_TYPOGRAPHY_PROFILE)
      const result = parseImportedBundle(json)
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.profiles).toHaveLength(1)
      const reimported = result.profiles[0]

      // Every block the Default profile styles must survive re-import byte-for-byte.
      expect(Object.keys(reimported.blocks).sort()).toEqual(Object.keys(DEFAULT_TYPOGRAPHY_PROFILE.blocks).sort())
      for (const key of Object.keys(DEFAULT_TYPOGRAPHY_PROFILE.blocks) as BlockTypeKey[]) {
        expect(reimported.blocks[key]).toEqual(DEFAULT_TYPOGRAPHY_PROFILE.blocks[key])
      }
      // The specific blocks the old bug dropped:
      expect(reimported.blocks.h4).toEqual(DEFAULT_TYPOGRAPHY_PROFILE.blocks.h4)
      expect(reimported.blocks.h5).toEqual(DEFAULT_TYPOGRAPHY_PROFILE.blocks.h5)
    })

    it('round-trips paragraph-variant blocks (previously outside BLOCK_KEYS)', () => {
      const profile = makeProfile({
        name: 'Variants',
        blocks: {
          title: { fontSize: '2rem', fontWeight: '800' },
          accented: { color: 'var(--sn-stylekit-info-color)' },
          strong: { fontWeight: '700' },
          emphasis: { fontStyle: 'italic' },
          normalSpaced: { marginBottom: '0.75rem' },
        },
      })
      const result = parseImportedBundle(profileToExportJson(profile))
      expect(result.ok).toBe(true)
      if (result.ok) {
        const blocks = result.profiles[0].blocks
        expect(blocks.title).toEqual({ fontSize: '2rem', fontWeight: '800' })
        expect(blocks.accented).toEqual({ color: 'var(--sn-stylekit-info-color)' })
        expect(blocks.strong).toEqual({ fontWeight: '700' })
        expect(blocks.emphasis).toEqual({ fontStyle: 'italic' })
        expect(blocks.normalSpaced).toEqual({ marginBottom: '0.75rem' })
      }
    })
  })

  describe('bundle export/import', () => {
    it('serializes one profile as a LEGACY single object, N as a bundle', () => {
      const a = makeProfile({ id: 'a', name: 'Alpha', blocks: { h1: { fontSize: '2rem' } } })
      const b = makeProfile({ id: 'b', name: 'Beta', blocks: { h2: { fontSize: '1.5rem' } } })

      const single = serializeProfilesForExport([a])
      expect(single.isBundle).toBe(false)
      expect(single.fileName).toBe('alpha.typography.json')
      expect(JSON.parse(single.json)).toEqual(a) // bare profile object, not wrapped

      const bundle = serializeProfilesForExport([a, b])
      expect(bundle.isBundle).toBe(true)
      expect(bundle.fileName).toBe(BUNDLE_EXPORT_FILE_NAME)
      const parsed = JSON.parse(bundle.json)
      expect(parsed.schemaVersion).toBe(TYPOGRAPHY_PROFILE_SCHEMA_VERSION)
      expect(parsed.profiles).toHaveLength(2)
    })

    it('round-trips an N-profile bundle', () => {
      const a = makeProfile({ id: 'a', name: 'Alpha', blocks: { h1: { fontSize: '2rem' } } })
      const b = makeProfile({ id: 'b', name: 'Beta', blocks: { code: { fontFamily: 'monospace' } } })
      const result = parseImportedBundle(bundleToExportJson([a, b]))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.isBundle).toBe(true)
        expect(result.profiles).toHaveLength(2)
        expect(result.results.map((r) => (r.ok ? r.sourceName : null))).toEqual(['Alpha', 'Beta'])
        expect(result.profiles[0].blocks.h1).toEqual({ fontSize: '2rem' })
        expect(result.profiles[1].blocks.code).toEqual({ fontFamily: 'monospace' })
        // fresh ids + isDefault forced off on every entry
        expect(result.profiles.every((p) => p.isDefault === false)).toBe(true)
        expect(result.profiles[0].id).not.toBe('a')
      }
    })

    it('still imports a legacy single-profile file through the bundle reader', () => {
      const legacy = makeProfile({ name: 'Legacy', blocks: { quote: { color: 'red' } } })
      const result = parseImportedBundle(profileToExportJson(legacy))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.isBundle).toBe(false)
        expect(result.profiles).toHaveLength(1)
        expect(result.profiles[0].name).toBe('Legacy')
        expect(result.profiles[0].blocks.quote).toEqual({ color: 'red' })
      }
    })

    it('returns typed errors for malformed / incompatible files', () => {
      const badJson = parseImportedBundle('{not json')
      expect(badJson.ok).toBe(false)
      if (!badJson.ok) {
        expect(badJson.error.code).toBe('invalid-json')
      }

      const wrongShape = parseImportedBundle('[]')
      expect(wrongShape.ok).toBe(false)
      if (!wrongShape.ok) {
        expect(wrongShape.error.code).toBe('wrong-shape')
      }

      const newerBundle = parseImportedBundle(
        JSON.stringify({ schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION + 1, profiles: [{ name: 'X', blocks: {} }] }),
      )
      expect(newerBundle.ok).toBe(false)
      if (!newerBundle.ok) {
        expect(newerBundle.error.code).toBe('unsupported-schema-version')
      }

      const emptyBundle = parseImportedBundle(
        JSON.stringify({ schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION, profiles: [] }),
      )
      expect(emptyBundle.ok).toBe(false)
      if (!emptyBundle.ok) {
        expect(emptyBundle.error.code).toBe('empty')
      }
    })

    it('surfaces a per-entry error without failing the whole bundle', () => {
      const result = parseImportedBundle(
        JSON.stringify({
          schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
          profiles: [{ name: 'Good', blocks: { h1: { fontSize: '2rem' } } }, 42],
        }),
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.results).toHaveLength(2)
        expect(result.results[0].ok).toBe(true)
        expect(result.results[1].ok).toBe(false)
        expect(result.profiles).toHaveLength(1) // only the good one
      }
    })
  })

  describe('partial selection', () => {
    const alpha = makeProfile({
      id: 'a',
      name: 'Alpha',
      blocks: { h1: { fontSize: '2rem' }, h2: { fontSize: '1.5rem' } },
    })
    const beta = makeProfile({ id: 'b', name: 'Beta', blocks: { code: { fontFamily: 'monospace' } } })

    it('builds a full selection of every carried block, in catalog order', () => {
      const selection = buildFullSelection([alpha, beta])
      expect(selection).toEqual({ a: ['h1', 'h2'], b: ['code'] })
      expect(countSelectedBlocks(selection)).toBe(3)
    })

    it('toggles individual blocks and whole profiles immutably', () => {
      let selection = buildFullSelection([alpha, beta])
      selection = setBlockSelected(selection, 'a', 'h1', false)
      expect(selection.a).toEqual(['h2'])
      selection = setProfileSelected(selection, beta, false)
      expect(selection.b).toBeUndefined()
      selection = setBlockSelected(selection, 'a', 'h2', false) // last block → profile drops out
      expect(selection.a).toBeUndefined()
    })

    it('picks only chosen (and actually present) blocks', () => {
      const picked = pickProfileBlocks(alpha, ['h1', 'code' as BlockTypeKey])
      expect(Object.keys(picked.blocks)).toEqual(['h1']) // h2 dropped, code not present
      expect(picked.blocks.h1).toEqual({ fontSize: '2rem' })
    })

    it('selectFromBundle reduces each profile to its selected blocks, preserving order', () => {
      const selection = { a: ['h2'] as BlockTypeKey[], b: ['code'] as BlockTypeKey[] }
      const out = selectFromBundle([alpha, beta], selection)
      expect(out.map((p) => p.id)).toEqual(['a', 'b'])
      expect(out[0].blocks).toEqual({ h2: { fontSize: '1.5rem' } })
      expect(out[1].blocks).toEqual({ code: { fontFamily: 'monospace' } })
    })
  })

  describe('computeSanitizationDiff (truthful preview)', () => {
    it('reports per-declaration kept vs dropped matching the REAL sanitiser', () => {
      const diff = computeSanitizationDiff({
        blocks: {
          h1: {
            fontSize: '2rem', // kept
            backgroundColor: 'url(https://evil.example/x.png)', // dropped (CSP-unsafe)
            somethingUnknown: 'whatever', // dropped (unknown key)
          },
          notARealBlock: { color: 'red' }, // whole block dropped (unknown key)
        },
      })

      const h1 = diff.blocks.find((b) => b.key === 'h1')!
      expect(h1.known).toBe(true)
      const byProp = Object.fromEntries(h1.declarations.map((d) => [d.property, d.status]))
      expect(byProp.fontSize).toBe('kept')
      expect(byProp.backgroundColor).toBe('dropped')
      expect(byProp.somethingUnknown).toBe('dropped')
      expect(h1.keptCount).toBe(1)
      expect(h1.droppedCount).toBe(2)

      const unknown = diff.blocks.find((b) => b.key === 'notARealBlock')!
      expect(unknown.known).toBe(false)

      // Cross-check the diff's kept set against what the parser actually keeps.
      const parsed = parseImportedBundle(
        JSON.stringify({
          schemaVersion: TYPOGRAPHY_PROFILE_SCHEMA_VERSION,
          name: 'x',
          blocks: {
            h1: { fontSize: '2rem', backgroundColor: 'url(https://evil.example/x.png)', somethingUnknown: 'whatever' },
          },
        }),
      )
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.profiles[0].blocks.h1).toEqual({ fontSize: '2rem' })
      }
    })
  })

  describe('resolveImport (create-new vs merge-into-existing)', () => {
    const existing = [
      makeProfile({ id: 'default', name: 'Default', isDefault: true, blocks: { h1: { fontSize: '1rem' } } }),
      makeProfile({ id: 'custom', name: 'Alpha', blocks: { h2: { fontSize: '1.2rem' } } }),
    ]

    it('create mode appends fresh, uniquely-named, non-default profiles', () => {
      const incoming = [makeProfile({ id: 'x', name: 'Alpha', blocks: { h3: { fontSize: '1.1rem' } } })]
      const out = resolveImport(existing, incoming, { mode: 'create' })
      expect(out).toHaveLength(3)
      const added = out[2]
      expect(added.name).toBe('Alpha 2') // de-duped against existing "Alpha"
      expect(added.isDefault).toBe(false)
      expect(added.id).not.toBe('x')
      expect(added.blocks.h3).toEqual({ fontSize: '1.1rem' })
      // existing untouched
      expect(out[0]).toEqual(existing[0])
    })

    it('merge mode overwrites only the incoming blocks of the target, keeping the rest', () => {
      const incoming = [
        makeProfile({ id: 'x', name: 'From file', blocks: { h1: { fontSize: '9rem' }, h3: { color: 'red' } } }),
      ]
      const out = resolveImport(existing, incoming, { mode: 'merge', targetProfileId: 'custom' })
      expect(out).toHaveLength(2) // no new profile
      const target = out.find((p) => p.id === 'custom')!
      expect(target.blocks.h2).toEqual({ fontSize: '1.2rem' }) // preserved
      expect(target.blocks.h1).toEqual({ fontSize: '9rem' }) // merged in
      expect(target.blocks.h3).toEqual({ color: 'red' }) // merged in
      // the non-target profile is untouched
      expect(out[0]).toEqual(existing[0])
    })
  })
})
