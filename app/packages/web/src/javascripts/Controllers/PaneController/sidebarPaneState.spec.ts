/**
 * @jest-environment jsdom
 *
 * The sidebars' remembered STATE and current STATUS, as pure functions.
 *
 * Two of the assertions here deliberately read ANOTHER file's source text rather
 * than calling into it:
 *
 *  - the pane minimums are module-private constants in `PanesSystemComponent`,
 *    and this module has to mirror them to clamp a restored width in the
 *    controller. Mirroring without a guard is how two numbers drift apart.
 *  - the four restore sites in that same file are wired to `clampPanelWidth` by
 *    inspection only — no spec mounts that component (it pulls in the whole pane
 *    system), so removing one of those four calls would otherwise survive every
 *    gate. A static assertion is a weaker proof than a mounted render, and it is
 *    strictly stronger than none: deleting a clamp fails this file.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { LocalPrefKey } from '@standardnotes/services'
import { AppPaneId } from '../../Components/Panes/AppPaneMetadata'
import { NAVIGATION_MINI_RAIL_WIDTH, NAVIGATION_PANE_MINI_PREF_KEY } from '../../Components/Tags/navigationMini'
import {
  ITEMS_PANEL_MIN_WIDTH,
  isSidebarPanePresent,
  launchPanes,
  listPaneStateFrom,
  NAVIGATION_PANEL_MIN_WIDTH,
  navigationPaneStateFrom,
  restoredItemsPanelWidth,
  restoredNavigationPanelWidth,
  SidebarPaneState,
  SidebarPaneStatus,
  sidebarPaneStatus,
} from './sidebarPaneState'

const navigationState = (
  options: { collapsed?: unknown; mini?: unknown; isTabletOrMobile?: boolean } = {},
): SidebarPaneState =>
  navigationPaneStateFrom({
    collapsedPreference: options.collapsed,
    miniPreference: options.mini,
    isTabletOrMobile: options.isTabletOrMobile ?? false,
  })

describe('navigation sidebar state', () => {
  it('is expanded when nothing is stored', () => {
    expect(navigationState()).toBe(SidebarPaneState.Expanded)
  })

  it('is mini when the mini preference is on', () => {
    expect(navigationState({ mini: true })).toBe(SidebarPaneState.Mini)
  })

  it('is collapsed when the collapse preference is on', () => {
    expect(navigationState({ collapsed: true })).toBe(SidebarPaneState.Collapsed)
  })

  it('keeps collapsed winning over mini, so a removed pane is never resurrected as a rail', () => {
    expect(navigationState({ collapsed: true, mini: true })).toBe(SidebarPaneState.Collapsed)
  })

  it('suppresses mini below the desktop breakpoint, where the renderer draws the full column', () => {
    expect(navigationState({ mini: true, isTabletOrMobile: true })).toBe(SidebarPaneState.Expanded)
  })

  it.each([['true'], [1], ['mini'], [{}], [undefined], [null]])(
    'treats %p as not-mini, since a stored value can be anything an older build wrote',
    (stored) => {
      expect(navigationState({ mini: stored })).toBe(SidebarPaneState.Expanded)
    },
  )

  it.each([['true'], [1], [undefined], [null]])('treats %p as not-collapsed for the same reason', (stored) => {
    expect(navigationState({ collapsed: stored })).toBe(SidebarPaneState.Expanded)
  })
})

describe('notes list state', () => {
  it('has only two states: a 48px column of note titles would show no titles', () => {
    expect(listPaneStateFrom({ collapsedPreference: true })).toBe(SidebarPaneState.Collapsed)
    expect(listPaneStateFrom({ collapsedPreference: false })).toBe(SidebarPaneState.Expanded)
    expect(listPaneStateFrom({ collapsedPreference: undefined })).toBe(SidebarPaneState.Expanded)
    expect(listPaneStateFrom({ collapsedPreference: 'true' })).toBe(SidebarPaneState.Expanded)
  })
})

describe('pane presence', () => {
  it('counts mini as present — a rail is a visible pane, not a third kind of pane', () => {
    expect(isSidebarPanePresent(SidebarPaneState.Mini)).toBe(true)
    expect(isSidebarPanePresent(SidebarPaneState.Expanded)).toBe(true)
    expect(isSidebarPanePresent(SidebarPaneState.Collapsed)).toBe(false)
  })
})

describe('launch layout', () => {
  const launch = (
    navigationPaneState: SidebarPaneState,
    listPaneState: SidebarPaneState,
    options: { isTabletOrMobile?: boolean; restoreAssistant?: boolean } = {},
  ) =>
    launchPanes({
      isTabletOrMobile: options.isTabletOrMobile ?? false,
      navigationPaneState,
      listPaneState,
      restoreAssistant: options.restoreAssistant ?? false,
    })

  it('restores all three navigation states, with mini in the stack at the sidebar position', () => {
    expect(launch(SidebarPaneState.Expanded, SidebarPaneState.Expanded)).toEqual([
      AppPaneId.Navigation,
      AppPaneId.Items,
      AppPaneId.Editor,
    ])
    expect(launch(SidebarPaneState.Mini, SidebarPaneState.Expanded)).toEqual([
      AppPaneId.Navigation,
      AppPaneId.Items,
      AppPaneId.Editor,
    ])
    expect(launch(SidebarPaneState.Collapsed, SidebarPaneState.Expanded)).toEqual([AppPaneId.Items, AppPaneId.Editor])
  })

  it('keeps the four collapse combinations the layout shipped with', () => {
    expect(launch(SidebarPaneState.Expanded, SidebarPaneState.Collapsed)).toEqual([
      AppPaneId.Navigation,
      AppPaneId.Editor,
    ])
    expect(launch(SidebarPaneState.Collapsed, SidebarPaneState.Collapsed)).toEqual([AppPaneId.Editor])
    expect(launch(SidebarPaneState.Mini, SidebarPaneState.Collapsed)).toEqual([AppPaneId.Navigation, AppPaneId.Editor])
  })

  it('never resurrects a pane the tablet breakpoint removed, in any sidebar state', () => {
    for (const navigation of [SidebarPaneState.Collapsed, SidebarPaneState.Mini, SidebarPaneState.Expanded]) {
      for (const list of [SidebarPaneState.Collapsed, SidebarPaneState.Expanded]) {
        // The tablet/mobile branch is a navigation STACK, not columns: both panes
        // are pushed and one is shown at a time, so no collapse or mini state
        // applies — and nothing here can add a third column.
        expect(launch(navigation, list, { isTabletOrMobile: true })).toEqual([AppPaneId.Navigation, AppPaneId.Items])
      }
    }
  })

  it('docks a restored assistant to the right on desktop and to the top of the stack on mobile', () => {
    expect(launch(SidebarPaneState.Mini, SidebarPaneState.Expanded, { restoreAssistant: true })).toEqual([
      AppPaneId.Navigation,
      AppPaneId.Items,
      AppPaneId.Editor,
      AppPaneId.Assistant,
    ])
    expect(
      launch(SidebarPaneState.Expanded, SidebarPaneState.Expanded, {
        isTabletOrMobile: true,
        restoreAssistant: true,
      }),
    ).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Assistant])
  })

  it('leaves the assistant out when it was not open', () => {
    expect(launch(SidebarPaneState.Expanded, SidebarPaneState.Expanded)).not.toContain(AppPaneId.Assistant)
  })
})

describe('sidebar status', () => {
  it('separates "the user collapsed it" from "the layout is hiding it"', () => {
    expect(sidebarPaneStatus({ present: true, focusModeEnabled: false })).toBe(SidebarPaneStatus.Visible)
    expect(sidebarPaneStatus({ present: false, focusModeEnabled: false })).toBe(SidebarPaneStatus.Collapsed)
    expect(sidebarPaneStatus({ present: true, focusModeEnabled: true })).toBe(SidebarPaneStatus.HiddenByFocusMode)
  })

  it('reports focus mode even for a pane that is also collapsed: that is the reason the user can act on', () => {
    expect(sidebarPaneStatus({ present: false, focusModeEnabled: true })).toBe(SidebarPaneStatus.HiddenByFocusMode)
  })
})

describe('restored widths', () => {
  it('floors a restored width at the pane minimum', () => {
    expect(restoredNavigationPanelWidth(10, 220)).toBe(NAVIGATION_PANEL_MIN_WIDTH)
    expect(restoredItemsPanelWidth(10, 350)).toBe(ITEMS_PANEL_MIN_WIDTH)
  })

  it('keeps a usable stored width exactly as stored', () => {
    expect(restoredNavigationPanelWidth(300, 220)).toBe(300)
    expect(restoredItemsPanelWidth(500, 350)).toBe(500)
  })

  it.each([[undefined], [null], [0], [-20], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'falls back to the pane DEFAULT, not its minimum, for %p',
    (stored) => {
      // "Never configured" and "dragged as narrow as it goes" are different
      // facts: a zero left behind by focus mode must not read as a 48px rail the
      // user chose.
      expect(restoredNavigationPanelWidth(stored as number | undefined | null, 220)).toBe(220)
      expect(restoredItemsPanelWidth(stored as number | undefined | null, 350)).toBe(350)
    },
  )
})

describe('agreement with the files this state is shared with', () => {
  const sourceOf = (...segments: string[]) => readFileSync(join(__dirname, '..', '..', ...segments), 'utf8')
  const panesSystem = sourceOf('Components', 'Panes', 'PanesSystemComponent.tsx')
  const collapsed = panesSystem.replace(/\s+/g, ' ')
  const occurrences = (needle: string) => collapsed.split(needle).length - 1

  it('reads the mini preference under the same stored key the sidebar writes', () => {
    // The controller types its read off the `LocalPrefKey` enum; the sidebar pins
    // the literal, because web resolves snjs's RUNTIME enum from a generated
    // bundle that predates the key. Different spellings would mean the launch
    // restore and the renderer consulting two different preferences.
    expect(LocalPrefKey.NavigationPaneMini).toBe(NAVIGATION_PANE_MINI_PREF_KEY)
    expect(String(NAVIGATION_PANE_MINI_PREF_KEY)).toBe('navigationPaneMini')
  })

  it('mirrors the pane minimums the pane system actually renders with', () => {
    const itemsMinimum = /const ITEMS_PANEL_MIN_WIDTH = (\d+)/.exec(panesSystem)
    expect(itemsMinimum).not.toBeNull()
    expect(Number((itemsMinimum as RegExpExecArray)[1])).toBe(ITEMS_PANEL_MIN_WIDTH)

    // The navigation minimum is not mirrored at all — both files read the one
    // constant — so this asserts the sharing rather than the number.
    expect(collapsed).toContain('const NAVIGATION_PANEL_MIN_WIDTH = NAVIGATION_MINI_RAIL_WIDTH')
    expect(NAVIGATION_PANEL_MIN_WIDTH).toBe(NAVIGATION_MINI_RAIL_WIDTH)
  })

  it('keeps every persisted-width read in the pane system behind a clamp', () => {
    expect(collapsed).toContain(
      'restoredNavigationPanelWidth(application.getPreference(PrefKey.TagsPanelWidth, NAVIGATION_PANEL_DEFAULT_WIDTH))',
    )
    expect(collapsed).toContain(
      'restoredItemsPanelWidth(application.getPreference(PrefKey.NotesPanelWidth, ITEMS_PANEL_DEFAULT_WIDTH))',
    )
    expect(collapsed).toContain('setNavigationPanelWidth(restoredNavigationPanelWidth(width))')
    expect(collapsed).toContain('setItemsPanelWidth(restoredItemsPanelWidth(width))')
  })

  it('has no read site above beyond the ones listed', () => {
    // A counted gate, so a NEWLY added read cannot be clamped by accident of the
    // four strings above still being present. If either count moves, the new site
    // belongs in the assertion above — or it is unclamped.
    expect(occurrences('getPreference(PrefKey.TagsPanelWidth')).toBe(2)
    expect(occurrences('getPreference(PrefKey.NotesPanelWidth')).toBe(1)
  })

  it('renders the Navigation column at the RAIL width in mini, at every site that describes it', () => {
    // The rail shipped fully built and fully inert: `NAVIGATION_MINI_RAIL_WIDTH`
    // reached this file only as the resizer's MINIMUM, so turning mini on drew
    // centred glyphs inside the stored 220px column. Both halves are asserted —
    // that ONE value is derived from the state, and that no site still
    // interpolates the stored width — because either one alone is satisfiable
    // while the column still renders at the wrong width.
    expect(collapsed).toContain('const isNavigationMini = navigationPaneState === SidebarPaneState.Mini')
    expect(collapsed).toContain(
      'const renderedNavigationPanelWidth = isNavigationMini ? NAVIGATION_MINI_RAIL_WIDTH : navigationPanelWidth',
    )
    // The three grid-track sites: `columnFor`, the two-pane case and the
    // three-pane case. A counted gate for the same reason as the one above — a
    // NEWLY added track that interpolated the stored width would otherwise sit
    // beside three correct ones and pass.
    expect(occurrences('${renderedNavigationPanelWidth}px')).toBe(3)
    expect(occurrences('${navigationPanelWidth}px')).toBe(0)
    // ...and the fourth site, which is not a track: the space the assistant pane
    // has to share with the sidebars.
    expect(collapsed).toContain(
      'paneController.panes.includes(AppPaneId.Navigation) ? renderedNavigationPanelWidth : 0',
    )
  })

  it('derives that state with the one shared function, from inputs a React render re-reads', () => {
    // `PaneController.navigationPaneMini` is a plain preference mirror rather than
    // an observable, so an `observer` reading `paneController.navigationPaneState`
    // would not re-render when the switch is flipped. The RULE is shared with the
    // controller — this asserts there is exactly one call of it here and no second
    // hand-rolled "am I mini" — and the inputs are read the same way
    // `Navigation.tsx` reads them to decide what to draw inside the column.
    expect(collapsed).toContain(
      'const navigationPaneState = navigationPaneStateFrom({ collapsedPreference: navigationPaneCollapsedPreference, miniPreference: navigationPaneMiniPreference, isTabletOrMobile, })',
    )
    expect(occurrences('navigationPaneStateFrom(')).toBe(1)
    expect(collapsed).toContain('useLocalPreference(NAVIGATION_PANE_MINI_PREF_KEY)')
    expect(collapsed).toContain('useLocalPreference(LocalPrefKey.NavigationPaneCollapsed)')
  })

  it('offers no drag handle on a column that has exactly one width', () => {
    // A resizer mounted over the rail could not change the rendered column, and
    // its `resizeFinishCallback` would persist 48 over the user's stored expanded
    // width. The notes list resizer must NOT pick up the same gate.
    expect(collapsed).toContain('const showNavigationPanelResizer = showPanelResizers && !isNavigationMini')
    expect(collapsed).toContain('{showNavigationPanelResizer && navigationRef && (')
    expect(collapsed).toContain('{showPanelResizers && listRef && (')
  })
})
