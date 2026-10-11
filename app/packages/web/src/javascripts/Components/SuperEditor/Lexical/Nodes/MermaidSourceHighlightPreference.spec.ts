/**
 * Standard Red Notes — contracts for the mermaid-source-highlighting preference.
 *
 * THE ONE THAT MATTERS is the first describe: that the pinned literal and the
 * hardcoded default agree with `PrefKey` and `PrefDefaults`. The pin exists
 * because web reads `PrefKey`'s RUNTIME value out of the webpack-bundled
 * `@standardnotes/snjs`, where a brand-new member is `undefined` until both
 * `models` and `snjs` have been rebuilt. That makes the pin correct in the
 * browser and makes a typo in it INVISIBLE — a misspelled key reads and writes
 * consistently, so the toggle appears to work while storing a value nothing
 * reads. These two assertions are the only thing standing between that and a
 * shipped no-op.
 *
 * Note what they are asserted AGAINST: `@standardnotes/snjs`, i.e. the same
 * import the application uses, not `models/src`. Under jest that resolves
 * through the same `moduleNameMapper` web's runtime resolution uses, so if the
 * built artifact lacks the member these fail rather than passing against a
 * source file the browser never loads.
 */
import { PrefDefaults, PrefKey } from '@standardnotes/snjs'
import {
  DEFAULT_MERMAID_SOURCE_HIGHLIGHT,
  MERMAID_SOURCE_HIGHLIGHT_PREF_KEY,
  normalizeMermaidSourceHighlighting,
  readMermaidSourceHighlighting,
} from './MermaidSourceHighlightPreference'

describe('the pin against the enum it mirrors', () => {
  it('spells the key exactly as PrefKey does', () => {
    expect(MERMAID_SOURCE_HIGHLIGHT_PREF_KEY).toBe('superMermaidSourceHighlighting')
    expect(PrefKey.SuperMermaidSourceHighlighting).toBe(MERMAID_SOURCE_HIGHLIGHT_PREF_KEY)
  })

  it('has a DEFINED runtime value for the enum member', () => {
    // The stale-dist trap, named. `PrefKey.SuperMermaidSourceHighlighting`
    // reading `undefined` is how a new preference silently does nothing; this
    // is the assertion that notices.
    expect(PrefKey.SuperMermaidSourceHighlighting).toBeDefined()
    expect(typeof PrefKey.SuperMermaidSourceHighlighting).toBe('string')
  })

  it('agrees with PrefDefaults about the default', () => {
    expect(DEFAULT_MERMAID_SOURCE_HIGHLIGHT).toBe(true)
    expect(PrefDefaults[PrefKey.SuperMermaidSourceHighlighting]).toBe(DEFAULT_MERMAID_SOURCE_HIGHLIGHT)
  })

  it('finds the default under the literal key too', () => {
    // Belt and braces: if the enum member were missing at runtime the test
    // above would read `PrefDefaults[undefined]`, which is `undefined`, and the
    // failure message would blame the default rather than the enum. This one
    // points at the right thing.
    expect((PrefDefaults as unknown as Record<string, unknown>)['superMermaidSourceHighlighting']).toBe(true)
  })
})

describe('normalizeMermaidSourceHighlighting', () => {
  it('passes through an explicit boolean', () => {
    expect(normalizeMermaidSourceHighlighting(true)).toBe(true)
    expect(normalizeMermaidSourceHighlighting(false)).toBe(false)
  })

  it('reads anything else as ON', () => {
    // The value SYNCS, so another device running different code may have
    // written anything at all into it. Only an explicit `false` disables a
    // feature the user never opted out of.
    for (const raw of [undefined, null, '', 'false', 'true', 0, 1, {}, [], NaN]) {
      expect(normalizeMermaidSourceHighlighting(raw)).toBe(true)
    }
  })
})

describe('readMermaidSourceHighlighting', () => {
  it('asks for exactly the pinned key', () => {
    const getPreference = jest.fn(() => false)
    expect(readMermaidSourceHighlighting({ getPreference })).toBe(false)
    expect(getPreference).toHaveBeenCalledWith(MERMAID_SOURCE_HIGHLIGHT_PREF_KEY)
  })

  it('is ON when there is no application at all', () => {
    // The public share page: no `<ApplicationProvider>`, so no preferences. A
    // reader of a shared note gets the default rather than a throw.
    expect(readMermaidSourceHighlighting(null)).toBe(true)
    expect(readMermaidSourceHighlighting(undefined)).toBe(true)
  })

  it('is ON when the source cannot answer', () => {
    expect(readMermaidSourceHighlighting({} as unknown as { getPreference: (key: PrefKey) => unknown })).toBe(true)
  })

  it('does not swallow an explicit false', () => {
    expect(readMermaidSourceHighlighting({ getPreference: () => false })).toBe(false)
  })
})
