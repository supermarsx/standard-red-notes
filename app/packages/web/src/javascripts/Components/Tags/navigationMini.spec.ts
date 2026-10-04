/**
 * The sidebar's mini ("icon rail") projection.
 *
 * The one thing this file exists to stop: mini dropping a label out of the
 * accessibility tree. Hiding the `<span>` is the whole point of the rail, but
 * the name has to land in `title` + `aria-label` on the way out, or an
 * icon-only sidebar becomes eleven unnamed buttons for keyboard and
 * screen-reader users. `labelSurvivesInEveryMode` below asserts exactly that
 * invariant, in both modes, so no future edit can satisfy it by accident.
 *
 * Widths are deliberately NOT asserted here — jsdom has no layout engine, every
 * dimension reads 0, and mini does not set a width in the first place (the rail
 * width is a constant the pane system applies to its grid column). What is
 * assertable is the class list, the attributes and what renders at all.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  NAVIGATION_MINI_CONTAINER_CLASS,
  NAVIGATION_MINI_DATA_ATTR,
  NAVIGATION_MINI_INDENT_PER_LEVEL_PX,
  NAVIGATION_MINI_MAX_INDENT_LEVELS,
  NAVIGATION_MINI_RAIL_WIDTH,
  NAVIGATION_PANE_MINI_PREF_KEY,
  navigationEntryProjection,
  navigationMiniIndentPx,
  navigationTagRowProjection,
} from './navigationMini'

const FULL_ENTRY_CLASS =
  'flex w-full items-center gap-3 px-3.5 py-2 text-left text-base lg:text-sm ' +
  'hover:bg-contrast focus:bg-contrast focus:shadow-none focus:outline-none'

const MINI_ENTRY_CLASS =
  'flex w-full items-center justify-center px-0 py-2 text-left text-base lg:text-sm ' +
  'hover:bg-contrast focus:bg-contrast focus:shadow-none focus:outline-none'

describe('navigationMini — constants', () => {
  it('exports the rail width as the 48px the pane system already permits', () => {
    // The pane system's NAVIGATION_PANEL_MIN_WIDTH is 48: a 48px Navigation
    // column was always allowed, there was simply nothing rendered for it. The
    // number is exported so there is one source for it rather than two literals
    // that can drift apart.
    expect(NAVIGATION_MINI_RAIL_WIDTH).toBe(48)
  })

  it('pins the local preference key as the literal string it is stored under', () => {
    // Read off the enum object instead and this is `undefined` until the shared
    // snjs bundle is rebuilt, which would store the preference under the key
    // "undefined" and make the toggle look inert.
    //
    // The expected value is written out here deliberately rather than derived
    // from the constant: a test that compares the pin against a copy of itself
    // agrees with itself no matter what the pin says.
    expect(String(NAVIGATION_PANE_MINI_PREF_KEY)).toBe('navigationPaneMini')
  })

  it('pins the same string the LocalPrefKey enum declares, read from its source', () => {
    /**
     * The one failure mode a type-only cast cannot catch. `'x' as LocalPrefKey.Y`
     * launders any string past tsc, and a spec comparing the pin against another
     * copy of the pin is internally consistent and externally wrong — mini would
     * store under a key nothing else reads, and swapping the literal for the
     * plain enum member later would silently orphan every stored preference.
     *
     * So this reads the enum's OWN declaration off disk. The source file, not the
     * built bundle: `packages/snjs/dist/snjs.js` lags `src` and does not contain
     * this member yet, which is the whole reason the pin exists. Reading source
     * is the same approach `IconNameCoverage.spec.ts` takes for the other defect
     * class tsc is blind to.
     */
    const localPrefKeySource = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', 'services', 'src', 'Domain', 'Preferences', 'LocalPrefKey.ts'),
      'utf8',
    )

    const declaration = localPrefKeySource.match(/NavigationPaneMini\s*=\s*'([^']*)'/)

    expect(declaration).not.toBeNull()
    expect(String(NAVIGATION_PANE_MINI_PREF_KEY)).toBe(declaration?.[1])
  })

  it('names the container hook the stylesheet and the specs both key off', () => {
    expect(NAVIGATION_MINI_CONTAINER_CLASS).toBe('navigation-mini')
    expect(NAVIGATION_MINI_DATA_ATTR).toBe('data-navigation-mini')
  })
})

describe('navigationMini — fixed section entries', () => {
  it('leaves the full column exactly as it was before mini existed', () => {
    const entry = navigationEntryProjection({ mini: false, isActive: false, label: 'Dashboard' })

    expect(entry.className).toBe(FULL_ENTRY_CLASS)
    expect(entry.showLabel).toBe(true)
    expect(entry.labelClassName).toBe('flex-grow truncate font-semibold')
    // The rendered text is already the accessible name; a second copy in
    // `aria-label` would only create a way for the two to disagree.
    expect(entry.labelProps).toEqual({})
  })

  it('drops the visible label in mini and moves the name into title + aria-label', () => {
    const entry = navigationEntryProjection({ mini: true, isActive: false, label: 'Dashboard' })

    expect(entry.showLabel).toBe(false)
    expect(entry.labelProps).toEqual({ title: 'Dashboard', 'aria-label': 'Dashboard' })
    expect(entry.className).toBe(MINI_ENTRY_CLASS)
  })

  it('sheds the label gap and the horizontal padding that a 48px rail cannot afford', () => {
    const mini = navigationEntryProjection({ mini: true, isActive: false, label: 'Files' }).className.split(' ')

    expect(mini).toContain('justify-center')
    expect(mini).toContain('px-0')
    expect(mini).not.toContain('gap-3')
    expect(mini).not.toContain('px-3.5')
  })

  it('marks the active entry in both modes', () => {
    for (const mini of [false, true]) {
      const active = navigationEntryProjection({ mini, isActive: true, label: 'Todos' })

      expect(active.className.split(' ')).toContain('bg-contrast')
      expect(active.labelClassName).toBe('flex-grow truncate font-semibold text-info')
    }

    for (const mini of [false, true]) {
      const inactive = navigationEntryProjection({ mini, isActive: false, label: 'Todos' })

      expect(inactive.className.split(' ')).not.toContain('bg-contrast')
    }
  })

  it('uses the richer accessible name only where the visible label is gone', () => {
    const mini = navigationEntryProjection({
      mini: true,
      isActive: false,
      label: 'Notifications',
      accessibleLabel: 'Notifications, 3 notifications',
    })

    expect(mini.labelProps).toEqual({
      title: 'Notifications, 3 notifications',
      'aria-label': 'Notifications, 3 notifications',
    })

    const full = navigationEntryProjection({
      mini: false,
      isActive: false,
      label: 'Notifications',
      accessibleLabel: 'Notifications, 3 notifications',
    })

    expect(full.labelProps).toEqual({})
    expect(full.showLabel).toBe(true)
  })

  it('claims no accessible name at all when there is no label to move', () => {
    // An empty `title=""`/`aria-label=""` is a claim of its own — it names the
    // control "" rather than leaving it unnamed. A blank label must produce
    // neither attribute.
    for (const label of ['', '   ']) {
      expect(navigationEntryProjection({ mini: true, isActive: false, label }).labelProps).toEqual({})
    }
  })

  it('labelSurvivesInEveryMode: the label is always readable somewhere', () => {
    // The invariant the whole feature rests on. In the full column it is text;
    // in mini it is the accessible name. There is no mode in which it is gone.
    for (const mini of [false, true]) {
      const entry = navigationEntryProjection({ mini, isActive: false, label: 'Bookmarks' })
      const reachable = entry.showLabel || entry.labelProps['aria-label'] === 'Bookmarks'

      expect(reachable).toBe(true)
    }
  })
})

describe('navigationMini — nesting indent', () => {
  it('gives each level a token step so a sub-tag never reads as a root', () => {
    expect(navigationMiniIndentPx(0)).toBe(0)
    expect(navigationMiniIndentPx(1)).toBe(NAVIGATION_MINI_INDENT_PER_LEVEL_PX)
    expect(navigationMiniIndentPx(2)).toBe(2 * NAVIGATION_MINI_INDENT_PER_LEVEL_PX)
  })

  it('caps the indent so a deep tag cannot be pushed off the rail', () => {
    const ceiling = NAVIGATION_MINI_MAX_INDENT_LEVELS * NAVIGATION_MINI_INDENT_PER_LEVEL_PX

    expect(navigationMiniIndentPx(NAVIGATION_MINI_MAX_INDENT_LEVELS)).toBe(ceiling)
    expect(navigationMiniIndentPx(NAVIGATION_MINI_MAX_INDENT_LEVELS + 1)).toBe(ceiling)
    expect(navigationMiniIndentPx(50)).toBe(ceiling)
    // Even at the ceiling the glyph still has room: 20px icon inside a 48px rail.
    expect(ceiling).toBeLessThan(NAVIGATION_MINI_RAIL_WIDTH - 20)
  })

  it('treats a negative level as the root rather than a negative indent', () => {
    expect(navigationMiniIndentPx(-1)).toBe(0)
  })
})

describe('navigationMini — smart view and tag rows', () => {
  it('keeps the full column indent, padding and every element', () => {
    const row = navigationTagRowProjection({ mini: false, level: 2, indentPx: 56, label: 'Work' })

    expect(row.paddingClassName).toBe('px-3.5')
    expect(row.style).toEqual({ paddingLeft: '56px' })
    expect(row.showTitle).toBe(true)
    expect(row.showCount).toBe(true)
    expect(row.showMenu).toBe(true)
    expect(row.showHiddenMarker).toBe(true)
    expect(row.labelProps).toEqual({})
  })

  it('drops the title, count and context menu in mini, keeping the name as an attribute', () => {
    const row = navigationTagRowProjection({ mini: true, level: 2, indentPx: 56, label: 'Work' })

    expect(row.paddingClassName).toBe('px-0')
    expect(row.style).toEqual({ paddingLeft: `${navigationMiniIndentPx(2)}px` })
    expect(row.showTitle).toBe(false)
    // The count is dropped rather than truncated: a clipped "1…" would be a
    // wrong number, which is worse than a missing one.
    expect(row.showCount).toBe(false)
    expect(row.showMenu).toBe(false)
    // A second glyph will not fit beside the row's own at rail width.
    expect(row.showHiddenMarker).toBe(false)
    expect(row.labelProps).toEqual({ title: 'Work', 'aria-label': 'Work' })
  })

  it('carries a row’s marker state into its rail name, and only there', () => {
    const mini = navigationTagRowProjection({
      mini: true,
      level: 0,
      indentPx: 14,
      label: 'Work',
      accessibleLabel: 'Work, Hidden from the sidebar list',
    })

    expect(mini.labelProps).toEqual({
      title: 'Work, Hidden from the sidebar list',
      'aria-label': 'Work, Hidden from the sidebar list',
    })

    // In the full column the marker element is right there to be read, so the
    // row keeps the plain rendered title as its accessible name.
    const full = navigationTagRowProjection({
      mini: false,
      level: 0,
      indentPx: 14,
      label: 'Work',
      accessibleLabel: 'Work, Hidden from the sidebar list',
    })

    expect(full.labelProps).toEqual({})
    expect(full.showHiddenMarker).toBe(true)
  })

  it('names an untitled row nothing rather than naming it the empty string', () => {
    const row = navigationTagRowProjection({ mini: true, level: 0, indentPx: 14, label: '  ' })

    expect(row.labelProps).toEqual({})
  })

  it('labelSurvivesInEveryMode: a titled row is readable in both modes', () => {
    for (const mini of [false, true]) {
      const row = navigationTagRowProjection({ mini, level: 0, indentPx: 14, label: 'Work' })
      const reachable = row.showTitle || row.labelProps['aria-label'] === 'Work'

      expect(reachable).toBe(true)
    }
  })
})
