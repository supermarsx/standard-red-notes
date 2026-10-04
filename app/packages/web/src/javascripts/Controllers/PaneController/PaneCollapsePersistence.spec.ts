/**
 * @jest-environment jsdom
 *
 * Pane collapse persistence.
 *
 * The desktop three-pane layout lets the user independently collapse the
 * navigation sidebar and the notes list. Each collapsed state is persisted
 * locally (localStorage-backed local preferences) via `LocalPrefKey.*PaneCollapsed`
 * and restored on load. The collapse/expand actions live on `PaneController`
 * (`toggleListPane` / `toggleNavigationPane`) and mutate the `panes` array while
 * writing the new state through `preferences.setLocalValue`.
 *
 * SUBSTITUTION NOTE (mirrors the SinglePaneShell spec): `toggleListPane`,
 * `toggleNavigationPane`, `removePane`, and `insertPaneAtIndex` are class-field
 * arrow functions assigned inside PaneController's service-heavy constructor, so
 * they don't exist on a bare prototype instance. The first describe blocks below
 * therefore exercise the EXACT method bodies (verbatim from PaneController)
 * against a minimal state object. The collapsed-state getters ARE real prototype
 * getters, so those are invoked directly off the prototype.
 *
 * That substitution is no longer necessary, and the LAST describe block does not
 * use it: the constructor does run in jsdom against mocked services (the sibling
 * `AssistantPanePersistence.spec.ts` proved it), so the three-state restore,
 * its floor, and the width clamps below are asserted against the real
 * `PaneController` — a copied method body cannot catch a launch decision that
 * stops reading a preference.
 */
import { LocalPrefDefaults, LocalPrefKey, PreferenceServiceInterface } from '@standardnotes/services'
import {
  ApplicationEvent,
  InternalEventBusInterface,
  PrefDefaults,
  PrefKey,
  removeFromArray,
} from '@standardnotes/snjs'
import { KeyboardService } from '@standardnotes/ui-services'
import { AppPaneId } from '../../Components/Panes/AppPaneMetadata'
import { CommandService } from '../../Components/CommandPalette/CommandService'
import { IsTabletOrMobileScreen } from '../../Application/UseCase/IsTabletOrMobileScreen'
import { PanesForLayout } from '../../Application/UseCase/PanesForLayout'
import { NAVIGATION_MINI_RAIL_WIDTH } from '../../Components/Tags/navigationMini'
import { PaneController } from './PaneController'
import { ITEMS_PANEL_MIN_WIDTH, SidebarPaneState } from './sidebarPaneState'

type State = {
  panes: AppPaneId[]
  preferences: { setLocalValue: jest.Mock }
}

// Verbatim from PaneController.removePane / insertPaneAtIndex (minus logging).
const removePane = (state: State, pane: AppPaneId) => removeFromArray(state.panes, pane)
const insertPaneAtIndex = (state: State, pane: AppPaneId, index: number) => state.panes.splice(index, 0, pane)

// Verbatim from PaneController.toggleListPane.
const toggleListPane = (state: State) => {
  if (state.panes.includes(AppPaneId.Items)) {
    removePane(state, AppPaneId.Items)
    state.preferences.setLocalValue(LocalPrefKey.ListPaneCollapsed, true)
  } else {
    if (state.panes.includes(AppPaneId.Navigation)) {
      insertPaneAtIndex(state, AppPaneId.Items, 1)
    } else {
      insertPaneAtIndex(state, AppPaneId.Items, 0)
    }
    state.preferences.setLocalValue(LocalPrefKey.ListPaneCollapsed, false)
  }
}

// Verbatim from PaneController.toggleNavigationPane.
const toggleNavigationPane = (state: State) => {
  if (state.panes.includes(AppPaneId.Navigation)) {
    removePane(state, AppPaneId.Navigation)
    state.preferences.setLocalValue(LocalPrefKey.NavigationPaneCollapsed, true)
  } else {
    insertPaneAtIndex(state, AppPaneId.Navigation, 0)
    state.preferences.setLocalValue(LocalPrefKey.NavigationPaneCollapsed, false)
  }
}

const makeState = (panes: AppPaneId[]): State => ({
  panes,
  preferences: { setLocalValue: jest.fn() },
})

// Real prototype getters under test.
const getIsListPaneCollapsed = Object.getOwnPropertyDescriptor(PaneController.prototype, 'isListPaneCollapsed')!.get!
const getIsNavigationPaneCollapsed = Object.getOwnPropertyDescriptor(
  PaneController.prototype,
  'isNavigationPaneCollapsed',
)!.get!

describe('PaneController collapse persistence', () => {
  describe('toggleNavigationPane', () => {
    it('collapses the navigation pane and persists collapsed=true', () => {
      const state = makeState([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])

      toggleNavigationPane(state)

      expect(state.panes).toEqual([AppPaneId.Items, AppPaneId.Editor])
      expect(state.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.NavigationPaneCollapsed, true)
    })

    it('expands the navigation pane (restored at index 0) and persists collapsed=false', () => {
      const state = makeState([AppPaneId.Items, AppPaneId.Editor])

      toggleNavigationPane(state)

      expect(state.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])
      expect(state.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.NavigationPaneCollapsed, false)
    })
  })

  describe('toggleListPane', () => {
    it('collapses the notes list and persists collapsed=true', () => {
      const state = makeState([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])

      toggleListPane(state)

      expect(state.panes).toEqual([AppPaneId.Navigation, AppPaneId.Editor])
      expect(state.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ListPaneCollapsed, true)
    })

    it('re-inserts the notes list after navigation when navigation is shown', () => {
      const state = makeState([AppPaneId.Navigation, AppPaneId.Editor])

      toggleListPane(state)

      expect(state.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])
      expect(state.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ListPaneCollapsed, false)
    })

    it('re-inserts the notes list at index 0 when navigation is also collapsed', () => {
      const state = makeState([AppPaneId.Editor])

      toggleListPane(state)

      expect(state.panes).toEqual([AppPaneId.Items, AppPaneId.Editor])
      expect(state.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ListPaneCollapsed, false)
    })
  })

  describe('mini mode is not written by the collapse toggle', () => {
    it('collapses the navigation pane without touching the stored mini state', () => {
      const state = makeState([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])

      toggleNavigationPane(state)

      // The two preferences stay independent, which is what makes mini a third
      // STATE: collapsing a rail and expanding it again returns the rail.
      expect(state.preferences.setLocalValue.mock.calls.map(([key]) => key)).toEqual([
        LocalPrefKey.NavigationPaneCollapsed,
      ])
    })
  })

  describe('collapsed-state getters reflect the panes array (all four combinations)', () => {
    const cases: Array<[AppPaneId[], boolean, boolean]> = [
      [[AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor], false, false],
      [[AppPaneId.Items, AppPaneId.Editor], true, false],
      [[AppPaneId.Navigation, AppPaneId.Editor], false, true],
      [[AppPaneId.Editor], true, true],
    ]

    it.each(cases)('%j -> navCollapsed=%s listCollapsed=%s', (panes, navCollapsed, listCollapsed) => {
      const ctx = { panes }
      expect(getIsNavigationPaneCollapsed.call(ctx)).toBe(navCollapsed)
      expect(getIsListPaneCollapsed.call(ctx)).toBe(listCollapsed)
    })
  })
})

// ---------------------------------------------------------------------------
// The real controller, built in jsdom against mocked services. Everything under
// test below — the constructor's width restore, `handleEvent`, the three-state
// getters, `initializePanesIfEmpty` — is the shipped implementation.
// ---------------------------------------------------------------------------

type ScreenShape = { isTabletOrMobile: boolean; isTablet: boolean; isMobile: boolean }

type Harness = {
  controller: PaneController
  localValues: Map<LocalPrefKey, unknown>
  syncedValues: Map<PrefKey, unknown>
  setLocalValue: jest.Mock
  screen: ScreenShape
  localPreferencesChanged: () => Promise<void>
  preferencesChanged: () => Promise<void>
}

const installMatchMedia = (isMobile: boolean): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: jest.fn((query: string) => ({
      matches: query.includes('max-width: 767px') ? isMobile : !isMobile,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  })
}

const applicationEvent = (type: ApplicationEvent) =>
  ({ type }) as unknown as Parameters<PaneController['handleEvent']>[0]

const makeHarness = (
  options: {
    isTabletOrMobile?: boolean
    isTablet?: boolean
    local?: Array<[LocalPrefKey, unknown]>
    synced?: Array<[PrefKey, unknown]>
  } = {},
): Harness => {
  const isTabletOrMobile = options.isTabletOrMobile ?? false
  installMatchMedia(isTabletOrMobile)

  const localValues = new Map<LocalPrefKey, unknown>(options.local ?? [])
  const syncedValues = new Map<PrefKey, unknown>(options.synced ?? [])

  const setLocalValue = jest.fn((key: LocalPrefKey, value: unknown) => {
    localValues.set(key, value)
  })

  const preferences = {
    getValue: (key: PrefKey, defaultValue: unknown) => (syncedValues.has(key) ? syncedValues.get(key) : defaultValue),
    getLocalValue: (key: LocalPrefKey, defaultValue: unknown) =>
      localValues.has(key) ? localValues.get(key) : defaultValue,
    setLocalValue,
  } as unknown as PreferenceServiceInterface

  // Mutable, and read on every `execute()`, so a test can move the screen under
  // a controller the way a real resize does.
  const screen: ScreenShape = {
    isTabletOrMobile,
    isTablet: options.isTablet ?? false,
    isMobile: isTabletOrMobile && !(options.isTablet ?? false),
  }

  const controller = new PaneController(
    preferences,
    {} as KeyboardService,
    { addWithShortcut: jest.fn(() => jest.fn()) } as unknown as CommandService,
    { execute: () => ({ getValue: () => screen }) } as unknown as IsTabletOrMobileScreen,
    {
      execute: () => ({ getValue: () => [AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor] }),
    } as unknown as PanesForLayout,
    {
      addEventHandler: jest.fn(),
      publish: jest.fn(),
      publishSync: jest.fn(),
      deinit: jest.fn(),
    } as unknown as InternalEventBusInterface,
  )

  return {
    controller,
    localValues,
    syncedValues,
    setLocalValue,
    screen,
    localPreferencesChanged: () => controller.handleEvent(applicationEvent(ApplicationEvent.LocalPreferencesChanged)),
    preferencesChanged: () => controller.handleEvent(applicationEvent(ApplicationEvent.PreferencesChanged)),
  }
}

describe('PaneController restores mini as a third sidebar state', () => {
  it('defaults OFF, so the restored layout is the full labelled sidebar', async () => {
    expect(LocalPrefDefaults[LocalPrefKey.NavigationPaneMini]).toBe(false)

    const { controller, localPreferencesChanged } = makeHarness()
    await localPreferencesChanged()

    expect(controller.navigationPaneState).toBe(SidebarPaneState.Expanded)
    expect(controller.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])
  })

  it('restores the rail: the pane is in the launch stack and its state says mini', async () => {
    const { controller, localPreferencesChanged } = makeHarness({
      local: [[LocalPrefKey.NavigationPaneMini, true]],
    })

    await localPreferencesChanged()

    expect(controller.navigationPaneState).toBe(SidebarPaneState.Mini)
    expect(controller.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])
    expect(controller.isNavigationPaneCollapsed).toBe(false)
  })

  it('does not resurrect a collapsed sidebar as a rail', async () => {
    const { controller, localPreferencesChanged } = makeHarness({
      local: [
        [LocalPrefKey.NavigationPaneCollapsed, true],
        [LocalPrefKey.NavigationPaneMini, true],
      ],
    })

    await localPreferencesChanged()

    expect(controller.navigationPaneState).toBe(SidebarPaneState.Collapsed)
    expect(controller.panes).toEqual([AppPaneId.Items, AppPaneId.Editor])
  })

  it('does not claim mini on a tablet, where the sidebar renders as a full-width pane', async () => {
    const { controller, localPreferencesChanged } = makeHarness({
      isTabletOrMobile: true,
      isTablet: true,
      local: [[LocalPrefKey.NavigationPaneMini, true]],
    })

    await localPreferencesChanged()

    expect(controller.navigationPaneState).toBe(SidebarPaneState.Expanded)
    expect(controller.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items])
  })

  it('restores the rail through a collapse and expand round trip', async () => {
    const harness = makeHarness({ local: [[LocalPrefKey.NavigationPaneMini, true]] })
    await harness.localPreferencesChanged()

    harness.controller.toggleNavigationPane()
    await harness.localPreferencesChanged()

    expect(harness.localValues.get(LocalPrefKey.NavigationPaneCollapsed)).toBe(true)
    expect(harness.controller.navigationPaneState).toBe(SidebarPaneState.Collapsed)

    harness.controller.toggleNavigationPane()
    await harness.localPreferencesChanged()

    expect(harness.controller.navigationPaneState).toBe(SidebarPaneState.Mini)
    expect(harness.controller.panes).toContain(AppPaneId.Navigation)
    // The rail is still the stored answer: collapsing it never wrote mini away.
    expect(harness.localValues.get(LocalPrefKey.NavigationPaneMini)).toBe(true)
  })

  it('reads mini from the same stored preference the sidebar writes, and only as a literal true', async () => {
    const stringy = makeHarness({ local: [[LocalPrefKey.NavigationPaneMini, 'true']] })
    await stringy.localPreferencesChanged()
    expect(stringy.controller.navigationPaneState).toBe(SidebarPaneState.Expanded)

    const written = makeHarness()
    written.setLocalValue(LocalPrefKey.NavigationPaneMini, true)
    await written.localPreferencesChanged()
    expect(written.controller.navigationPaneState).toBe(SidebarPaneState.Mini)
  })

  it('leaves the notes list with two states', async () => {
    const expanded = makeHarness()
    await expanded.localPreferencesChanged()
    expect(expanded.controller.listPaneState).toBe(SidebarPaneState.Expanded)

    const collapsed = makeHarness({ local: [[LocalPrefKey.ListPaneCollapsed, true]] })
    await collapsed.localPreferencesChanged()
    expect(collapsed.controller.listPaneState).toBe(SidebarPaneState.Collapsed)
    expect(collapsed.controller.panes).toEqual([AppPaneId.Navigation, AppPaneId.Editor])
  })
})

describe('PaneController launch restore has a floor', () => {
  it('leaves the pane stack empty when the local preferences event never arrives', () => {
    const { controller } = makeHarness()

    // The bug this floor exists for: `LocalPreferencesChanged` is a one-shot
    // application-stage notification, so a controller built after that stage has
    // passed renders no columns at all and reports nothing.
    expect(controller.panes).toEqual([])
  })

  it('restores the stored layout when asked for panes with none', () => {
    const { controller } = makeHarness({ local: [[LocalPrefKey.ListPaneCollapsed, true]] })

    controller.initializePanesIfEmpty()

    expect(controller.panes).toEqual([AppPaneId.Navigation, AppPaneId.Editor])
  })

  it('does not consume the authoritative restore, which still corrects the layout once', async () => {
    // Local preferences are encrypted: a read before they are decrypted sees
    // nothing, which is why the floor must not be the last word.
    const harness = makeHarness()
    harness.controller.initializePanesIfEmpty()
    expect(harness.controller.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])
    expect(harness.controller.hasPaneInitializationLogicRun).toBe(false)

    harness.localValues.set(LocalPrefKey.NavigationPaneCollapsed, true)
    harness.localValues.set(LocalPrefKey.ListPaneCollapsed, true)
    await harness.localPreferencesChanged()

    expect(harness.controller.panes).toEqual([AppPaneId.Editor])
    expect(harness.controller.hasPaneInitializationLogicRun).toBe(true)
  })

  it('runs at most once: a second call is a no-op', () => {
    const { controller } = makeHarness()

    controller.initializePanesIfEmpty()
    expect(controller.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])

    // The user then navigates. A floor that re-ran here would silently undo it.
    controller.presentPane(AppPaneId.Items)
    const afterNavigating = [...controller.panes]
    expect(afterNavigating).not.toContain(AppPaneId.Editor)

    controller.initializePanesIfEmpty()

    expect(controller.panes).toEqual(afterNavigating)
  })

  it('never overrides a layout the user is already in', async () => {
    const harness = makeHarness()
    await harness.localPreferencesChanged()

    harness.controller.replacePanes([AppPaneId.Editor])
    harness.controller.initializePanesIfEmpty()

    expect(harness.controller.panes).toEqual([AppPaneId.Editor])
  })

  it('does not fight focus mode, which keeps both sidebars in the stack at zero width', async () => {
    const harness = makeHarness({ local: [[LocalPrefKey.NavigationPaneMini, true]] })
    await harness.localPreferencesChanged()

    harness.controller.setFocusModeEnabled(true)
    const duringFocusMode = [...harness.controller.panes]
    harness.controller.initializePanesIfEmpty()
    await harness.preferencesChanged()

    expect(harness.controller.panes).toEqual(duringFocusMode)
    expect(harness.controller.focusModeEnabled).toBe(true)
  })

  it('takes the synced preferences event as a second chance at the restore', async () => {
    const harness = makeHarness({ local: [[LocalPrefKey.NavigationPaneCollapsed, true]] })

    await harness.preferencesChanged()

    expect(harness.controller.panes).toEqual([AppPaneId.Items, AppPaneId.Editor])
    // Still not the authoritative run, so the local event may yet correct it.
    expect(harness.controller.hasPaneInitializationLogicRun).toBe(false)
  })

  it('restores an open assistant through the floor as well', () => {
    const { controller } = makeHarness({ local: [[LocalPrefKey.AssistantPaneOpen, true]] })

    controller.initializePanesIfEmpty()

    expect(controller.panes.at(-1)).toBe(AppPaneId.Assistant)
  })
})

describe('PaneController re-clamps a restored sidebar width', () => {
  const navDefault = PrefDefaults[PrefKey.TagsPanelWidth]
  const itemsDefault = PrefDefaults[PrefKey.NotesPanelWidth]

  it('floors a stored width below the pane minimum', () => {
    const { controller } = makeHarness({
      synced: [
        [PrefKey.TagsPanelWidth, 12],
        [PrefKey.NotesPanelWidth, 40],
      ],
    })

    expect(controller.currentNavPanelWidth).toBe(NAVIGATION_MINI_RAIL_WIDTH)
    expect(controller.currentItemsPanelWidth).toBe(ITEMS_PANEL_MIN_WIDTH)
  })

  it('falls back to the pane default for a width focus mode or a legacy write left unusable', () => {
    const { controller } = makeHarness({
      synced: [
        [PrefKey.TagsPanelWidth, 0],
        [PrefKey.NotesPanelWidth, Number.NaN],
      ],
    })

    expect(controller.currentNavPanelWidth).toBe(navDefault)
    expect(controller.currentItemsPanelWidth).toBe(itemsDefault)
  })

  it('keeps a usable stored width exactly as stored', () => {
    const { controller } = makeHarness({
      synced: [
        [PrefKey.TagsPanelWidth, 310],
        [PrefKey.NotesPanelWidth, 480],
      ],
    })

    expect(controller.currentNavPanelWidth).toBe(310)
    expect(controller.currentItemsPanelWidth).toBe(480)
  })

  it('re-clamps on every preferences change, not only at construction', async () => {
    const harness = makeHarness()
    expect(harness.controller.currentNavPanelWidth).toBe(navDefault)

    harness.syncedValues.set(PrefKey.TagsPanelWidth, 3)
    harness.syncedValues.set(PrefKey.NotesPanelWidth, 7)
    await harness.preferencesChanged()

    expect(harness.controller.currentNavPanelWidth).toBe(NAVIGATION_MINI_RAIL_WIDTH)
    expect(harness.controller.currentItemsPanelWidth).toBe(ITEMS_PANEL_MIN_WIDTH)
  })
})
