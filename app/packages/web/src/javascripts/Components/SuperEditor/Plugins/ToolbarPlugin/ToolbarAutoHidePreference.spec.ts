/**
 * Standard Red Notes — contracts for the toolbar auto-hide preference.
 *
 * THE ONE THAT MATTERS is the first describe: that the pinned literal and the
 * hardcoded default agree with `PrefKey` and `PrefDefaults`. The pin exists
 * because web reads `PrefKey`'s RUNTIME value out of the generated `snjs` bundle,
 * where a brand-new member is `undefined` until that bundle is rebuilt. That makes
 * the pin correct in the browser and makes a typo in it INVISIBLE: a misspelled
 * key reads and writes consistently, so the switch appears to work while storing
 * a value under a name no other client will ever look at.
 *
 * The agreement is checked against the models SOURCE FILES, read as text, and not
 * against `PrefKey` imported from `@standardnotes/snjs`. Imported, the member is
 * exactly the thing that may not exist yet — the comparison would be against
 * `undefined` on any machine whose bundle predates the member, and on a default-OFF
 * boolean a check that degrades to `undefined` is a check that passes for the
 * wrong reason. The source is what the next build is made from, so it is the
 * authority, and reading it needs nothing to have been built.
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  DEFAULT_SUPER_TOOLBAR_AUTO_HIDE,
  SUPER_TOOLBAR_AUTO_HIDE_PREF_KEY,
  isSuperToolbarAutoHideActive,
  normalizeSuperToolbarAutoHide,
} from './ToolbarAutoHidePreference'

const MODELS_USER_PREFS = resolve(__dirname, '../../../../../../..', 'models/src/Domain/Syncable/UserPrefs')
const readModelsSource = (file: string) => readFileSync(resolve(MODELS_USER_PREFS, file), 'utf8')

describe('the pin against the enum it mirrors', () => {
  it('spells the key exactly as written here', () => {
    expect(String(SUPER_TOOLBAR_AUTO_HIDE_PREF_KEY)).toBe('superToolbarAutoHide')
  })

  it('matches the member declared in the PrefKey enum source', () => {
    const source = readModelsSource('PrefKey.ts')
    // Anchored to a whole enum-member line. The file's comments talk about this
    // setting in prose, and an unanchored search would be satisfied by the prose.
    const member = /^ {2}SuperToolbarAutoHide = '([^']+)',$/m.exec(source)
    expect(member).not.toBeNull()
    expect(member?.[1]).toBe(String(SUPER_TOOLBAR_AUTO_HIDE_PREF_KEY))
  })

  it('is typed as a boolean preference in the PrefValue map', () => {
    expect(readModelsSource('PrefKey.ts')).toMatch(/^ {2}\[PrefKey\.SuperToolbarAutoHide\]: boolean$/m)
  })

  it('agrees with PrefDefaults that the setting ships OFF', () => {
    expect(DEFAULT_SUPER_TOOLBAR_AUTO_HIDE).toBe(false)
    const entry = /^ {2}\[PrefKey\.SuperToolbarAutoHide\]: (\w+),$/m.exec(readModelsSource('PrefDefaults.ts'))
    expect(entry).not.toBeNull()
    expect(entry?.[1]).toBe(String(DEFAULT_SUPER_TOOLBAR_AUTO_HIDE))
  })
})

describe('normalizeSuperToolbarAutoHide', () => {
  it('is on for an explicit true', () => {
    expect(normalizeSuperToolbarAutoHide(true)).toBe(true)
  })

  it('is off for everything else', () => {
    // `undefined` is the case that matters most: it is what a missing default
    // and an unset preference both read as, and it is what every existing user
    // has. The rest are what another client, or a corrupted value, might hold.
    for (const raw of [undefined, null, false, 'true', 'false', '', 0, 1, NaN, {}, [], [true]]) {
      expect(normalizeSuperToolbarAutoHide(raw)).toBe(false)
    }
  })
})

describe('isSuperToolbarAutoHideActive', () => {
  const applies = { storedPreference: true, isMobile: false, isToolbarFixedToTop: true, isEditable: true }

  it('applies to the docked desktop toolbar of an editable note when the setting is on', () => {
    expect(isSuperToolbarAutoHideActive(applies)).toBe(true)
  })

  it('does not apply unless the setting is explicitly on', () => {
    for (const storedPreference of [undefined, false, null, 'true', 1]) {
      expect(isSuperToolbarAutoHideActive({ ...applies, storedPreference })).toBe(false)
    }
  })

  it('never applies on mobile, where the toolbar already follows focus', () => {
    expect(isSuperToolbarAutoHideActive({ ...applies, isMobile: true })).toBe(false)
  })

  it('never applies to the floating selection toolbar', () => {
    expect(isSuperToolbarAutoHideActive({ ...applies, isToolbarFixedToTop: false })).toBe(false)
  })

  it('never applies to a locked or read-only note, which shows no toolbar', () => {
    expect(isSuperToolbarAutoHideActive({ ...applies, isEditable: false })).toBe(false)
  })

  it('needs every condition at once', () => {
    // Every combination: sixteen of them, exactly one of which applies.
    const booleans = [true, false]
    let active = 0
    for (const storedPreference of booleans) {
      for (const isMobile of booleans) {
        for (const isToolbarFixedToTop of booleans) {
          for (const isEditable of booleans) {
            if (isSuperToolbarAutoHideActive({ storedPreference, isMobile, isToolbarFixedToTop, isEditable })) {
              active++
            }
          }
        }
      }
    }
    expect(active).toBe(1)
  })
})
