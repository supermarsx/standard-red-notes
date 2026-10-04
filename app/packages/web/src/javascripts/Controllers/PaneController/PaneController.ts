import { PanesForLayout } from './../../Application/UseCase/PanesForLayout'
import {
  InternalEventHandlerInterface,
  InternalEventInterface,
  LocalPrefDefaults,
  LocalPrefKey,
  PreferenceServiceInterface,
} from '@standardnotes/services'
import {
  KeyboardService,
  TOGGLE_FOCUS_MODE_COMMAND,
  TOGGLE_LIST_PANE_KEYBOARD_COMMAND,
  TOGGLE_NAVIGATION_PANE_KEYBOARD_COMMAND,
} from '@standardnotes/ui-services'
import {
  ApplicationEvent,
  InternalEventBusInterface,
  PrefKey,
  removeFromArray,
  PrefDefaults,
} from '@standardnotes/snjs'
import { AppPaneId } from '../../Components/Panes/AppPaneMetadata'
import { isMobileScreen } from '@/Utils'
import { makeObservable, observable, action, computed } from 'mobx'
import { Disposer } from '@/Types/Disposer'
import { MediaQueryBreakpoints } from '@/Hooks/useMediaQuery'
import { AbstractViewController } from '../Abstract/AbstractViewController'
import { log, LoggingDomain } from '@/Logging'
import { PaneLayout } from './PaneLayout'
import { IsTabletOrMobileScreen } from '@/Application/UseCase/IsTabletOrMobileScreen'
import { CommandService } from '../../Components/CommandPalette/CommandService'
import { TABBABLE_PANES, ViewTab } from './ViewTab'
import {
  dockAssistantPaneToRight,
  insertPaneBeforeDockedAssistant,
  presentPaneBeforeDockedAssistant,
} from './assistantPaneLayout'
import {
  launchPanes,
  listPaneStateFrom,
  navigationPaneStateFrom,
  restoredItemsPanelWidth,
  restoredNavigationPanelWidth,
  SidebarPaneState,
} from './sidebarPaneState'

/**
 * The pane DEFAULT widths — the width a pane gets when nothing is stored for it.
 * They were called `Minimum*` while being read out of `PrefDefaults`, which is
 * how a restored width ended up never being compared against a real minimum at
 * all: there was no minimum in this file to compare it to. The actual minimums
 * live in `sidebarPaneState`, with the clamps that apply them.
 */
const DefaultNavPanelWidth = PrefDefaults[PrefKey.TagsPanelWidth]
const DefaultNotesPanelWidth = PrefDefaults[PrefKey.NotesPanelWidth]
const FOCUS_MODE_CLASS_NAME = 'focus-mode'
const DISABLING_FOCUS_MODE_CLASS_NAME = 'disable-focus-mode'
const FOCUS_MODE_ANIMATION_DURATION = 1255

export class PaneController extends AbstractViewController implements InternalEventHandlerInterface {
  isInMobileView = isMobileScreen()
  protected disposers: Disposer[] = []
  panes: AppPaneId[] = []

  /**
   * Standard Red Notes: full-column "pane" views surfaced as tabs in the editor
   * tab bar (Home, Dashboard, Reminders, Todos, Research) instead of taking over
   * the whole window as columns.
   */
  viewTabs: ViewTab[] = []
  activeViewTabId: string | undefined = undefined

  /**
   * Monotonic counter used to mint unique ids for empty tabs (multiple may be open
   * at once). Avoids Date.now()/Math.random() so ids are deterministic and stable
   * across renders within a session.
   */
  private emptyTabCounter = 0

  currentNavPanelWidth = 0
  currentItemsPanelWidth = 0
  focusModeEnabled = false
  hasPaneInitializationLogicRun = false

  listPaneExplicitelyCollapsed = this.preferences.getLocalValue(
    LocalPrefKey.ListPaneCollapsed,
    LocalPrefDefaults[LocalPrefKey.ListPaneCollapsed],
  )
  navigationPaneExplicitelyCollapsed = this.preferences.getLocalValue(
    LocalPrefKey.NavigationPaneCollapsed,
    LocalPrefDefaults[LocalPrefKey.NavigationPaneCollapsed],
  )
  /**
   * Standard Red Notes: the navigation sidebar's third state — the icon rail.
   *
   * Mirrored here beside the two collapse flags, and re-read with them on
   * `LocalPreferencesChanged`, so the launch restore reads ONE state per sidebar
   * instead of two independent facts it has to reconcile. Mini used to be read
   * only where it renders (`Components/Tags/Navigation.tsx`), which left the
   * launch decision unable to tell a rail from a full column — and unable to
   * refuse one on a screen that cannot show it.
   *
   * Like its two siblings this is a plain field rather than a mobx observable:
   * it is a preference mirror, and a React consumer reads the preference itself
   * through `useLocalPreference`, which re-renders on the same event that
   * refreshes this. `navigationPaneState` below is the single derived answer.
   */
  navigationPaneMini = this.preferences.getLocalValue(
    LocalPrefKey.NavigationPaneMini,
    LocalPrefDefaults[LocalPrefKey.NavigationPaneMini],
  )

  /**
   * Which of collapsed / mini / expanded each sidebar is in — the remembered
   * STATE, already vetoed by what this screen can actually show. See
   * `sidebarPaneState.ts` for why the two are separate questions.
   */
  get navigationPaneState(): SidebarPaneState {
    return navigationPaneStateFrom({
      collapsedPreference: this.navigationPaneExplicitelyCollapsed,
      miniPreference: this.navigationPaneMini,
      isTabletOrMobile: this._isTabletOrMobileScreen.execute().getValue().isTabletOrMobile,
    })
  }

  get listPaneState(): SidebarPaneState {
    return listPaneStateFrom({ collapsedPreference: this.listPaneExplicitelyCollapsed })
  }

  private isAssistantPanePersistedOpen(): boolean {
    return (
      this.preferences.getLocalValue(
        LocalPrefKey.AssistantPaneOpen,
        LocalPrefDefaults[LocalPrefKey.AssistantPaneOpen],
      ) === true
    )
  }

  private persistAssistantPaneOpen(open: boolean): void {
    if (this.isAssistantPanePersistedOpen() === open) {
      return
    }

    this.preferences.setLocalValue(LocalPrefKey.AssistantPaneOpen, open)
  }

  constructor(
    private preferences: PreferenceServiceInterface,
    keyboardService: KeyboardService,
    commands: CommandService,
    private _isTabletOrMobileScreen: IsTabletOrMobileScreen,
    private _panesForLayout: PanesForLayout,
    eventBus: InternalEventBusInterface,
  ) {
    super(eventBus)

    makeObservable(this, {
      panes: observable,
      viewTabs: observable,
      activeViewTabId: observable,
      isInMobileView: observable,
      currentNavPanelWidth: observable,
      currentItemsPanelWidth: observable,
      focusModeEnabled: observable,

      currentPane: computed,
      previousPane: computed,
      activeViewTab: computed,
      isListPaneCollapsed: computed,
      isNavigationPaneCollapsed: computed,

      openPaneTab: action,
      openConflictTab: action,
      openEmptyTab: action,
      closeViewTab: action,
      setActiveViewTab: action,

      setIsInMobileView: action,
      toggleListPane: action,
      toggleNavigationPane: action,
      setCurrentItemsPanelWidth: action,
      setCurrentNavPanelWidth: action,
      presentPane: action,
      dismissLastPane: action,
      replacePanes: action,
      popToPane: action,
      removePane: action,
      insertPaneAtIndex: action,
      setPaneLayout: action,
      setFocusModeEnabled: action,
      initializePanesIfEmpty: action,
    })

    this.restorePanelWidths()

    const mediaQuery = window.matchMedia(MediaQueryBreakpoints.md)
    if (mediaQuery?.addEventListener != undefined) {
      mediaQuery.addEventListener('change', this.mediumScreenMQHandler)
    } else {
      mediaQuery.addListener(this.mediumScreenMQHandler)
    }

    eventBus.addEventHandler(this, ApplicationEvent.PreferencesChanged)
    eventBus.addEventHandler(this, ApplicationEvent.LocalPreferencesChanged)

    this.disposers.push(
      commands.addWithShortcut(TOGGLE_FOCUS_MODE_COMMAND, 'General', 'Toggle focus mode', (event) => {
        event?.preventDefault()
        this.toggleFocusMode()
      }),
      commands.addWithShortcut(TOGGLE_LIST_PANE_KEYBOARD_COMMAND, 'General', 'Toggle notes panel', (event) => {
        event?.preventDefault()
        this.toggleListPane()
      }),
      commands.addWithShortcut(TOGGLE_NAVIGATION_PANE_KEYBOARD_COMMAND, 'General', 'Toggle tags panel', (event) => {
        event?.preventDefault()
        this.toggleNavigationPane()
      }),
    )
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    if (event.type === ApplicationEvent.PreferencesChanged) {
      this.restorePanelWidths()

      // Second chance at the launch restore, for the case below where the local
      // preferences event never reaches this controller. By the time any
      // preference event fires, storage has been decrypted, so the local values
      // read here are the real ones.
      this.initializePanesIfEmpty()
    }
    if (event.type === ApplicationEvent.LocalPreferencesChanged) {
      this.listPaneExplicitelyCollapsed = this.preferences.getLocalValue(
        LocalPrefKey.ListPaneCollapsed,
        LocalPrefDefaults[LocalPrefKey.ListPaneCollapsed],
      )
      this.navigationPaneExplicitelyCollapsed = this.preferences.getLocalValue(
        LocalPrefKey.NavigationPaneCollapsed,
        LocalPrefDefaults[LocalPrefKey.NavigationPaneCollapsed],
      )
      this.navigationPaneMini = this.preferences.getLocalValue(
        LocalPrefKey.NavigationPaneMini,
        LocalPrefDefaults[LocalPrefKey.NavigationPaneMini],
      )

      if (!this.hasPaneInitializationLogicRun) {
        this.restorePaneLayout()
        this.hasPaneInitializationLogicRun = true
      }
    }
  }

  /**
   * Rebuild the pane stack from the persisted sidebar state. Pure decision in
   * `launchPanes`; this only supplies the inputs and assigns the result.
   */
  private restorePaneLayout(): void {
    this.panes = launchPanes({
      isTabletOrMobile: this._isTabletOrMobileScreen.execute().getValue().isTabletOrMobile,
      navigationPaneState: this.navigationPaneState,
      listPaneState: this.listPaneState,
      restoreAssistant: this.isAssistantPanePersistedOpen(),
    })
  }

  /**
   * The restore above runs on the FIRST `LocalPreferencesChanged`, because that
   * is the earliest point at which the stored layout can be read: local
   * preferences are encrypted, and `PreferencesService` only publishes them once
   * `ApplicationStage.StorageDecrypted_09` is reached — a read in this
   * constructor sees `{}` and would restore defaults over the user's choice.
   *
   * But that event is a one-shot stage notification. A controller built after
   * the stage has already passed never sees it, and `panes` then stays `[]`
   * forever: no columns, nothing on screen, no error anywhere.
   *
   * So this is the floor. It is guarded by TWO conditions, and the pair is what
   * keeps it from being a second, competing restore:
   *
   *  - `panes.length === 0` — it can only ever act when there is nothing on
   *    screen at all, so it cannot clobber a layout the user is using, cannot
   *    fight focus mode (which keeps both sidebars in the stack), and cannot run
   *    twice, since one run leaves the stack non-empty.
   *  - `!hasPaneInitializationLogicRun` — and it deliberately does NOT set that
   *    flag. If this ran first with preferences that were not decrypted yet, the
   *    authoritative restore is still allowed to correct the layout when the real
   *    event arrives.
   */
  initializePanesIfEmpty = (): void => {
    if (this.hasPaneInitializationLogicRun || this.panes.length > 0) {
      return
    }

    log(LoggingDomain.Panes, 'Initializing empty pane stack from persisted sidebar state')

    this.restorePaneLayout()
  }

  /**
   * Re-read both persisted sidebar widths, each re-clamped against its pane's
   * own minimum — see `restoredNavigationPanelWidth`. Nothing validated these on
   * read, so a width below the minimum (focus mode drives these columns to `0`)
   * could be stored and handed straight back.
   */
  private restorePanelWidths(): void {
    this.setCurrentNavPanelWidth(
      restoredNavigationPanelWidth(
        this.preferences.getValue(PrefKey.TagsPanelWidth, DefaultNavPanelWidth),
        DefaultNavPanelWidth,
      ),
    )
    this.setCurrentItemsPanelWidth(
      restoredItemsPanelWidth(
        this.preferences.getValue(PrefKey.NotesPanelWidth, DefaultNotesPanelWidth),
        DefaultNotesPanelWidth,
      ),
    )
  }

  setCurrentNavPanelWidth(width: number) {
    this.currentNavPanelWidth = width
  }

  setCurrentItemsPanelWidth(width: number) {
    this.currentItemsPanelWidth = width
  }

  deinit() {
    super.deinit()
    const mq = window.matchMedia(MediaQueryBreakpoints.md)
    if (mq?.removeEventListener != undefined) {
      mq.removeEventListener('change', this.mediumScreenMQHandler)
    } else {
      mq.removeListener(this.mediumScreenMQHandler)
    }
  }

  get currentPane(): AppPaneId {
    return this.panes[this.panes.length - 1] || this.panes[0]
  }

  get previousPane(): AppPaneId {
    return this.panes[this.panes.length - 2] || this.panes[0]
  }

  mediumScreenMQHandler = (event: MediaQueryListEvent) => {
    if (event.matches) {
      this.setIsInMobileView(false)
    } else {
      this.setIsInMobileView(true)
    }
  }

  setIsInMobileView = (isInMobileView: boolean) => {
    const wasInMobileView = this.isInMobileView
    this.isInMobileView = isInMobileView

    // Mobile uses a navigation stack and may legitimately place another pane
    // after Assistant. As soon as the same controller returns to desktop,
    // restore the desktop dock invariant instead of waiting for a later action.
    if (wasInMobileView && !isInMobileView && this.panes.includes(AppPaneId.Assistant)) {
      this.panes = dockAssistantPaneToRight(this.panes, true)
    }
  }

  setPaneLayout = (layout: PaneLayout) => {
    log(LoggingDomain.Panes, 'Set pane layout', layout)

    const panes = this._panesForLayout.execute(layout).getValue()

    if (panes.includes(AppPaneId.Items) && this.listPaneExplicitelyCollapsed && layout !== PaneLayout.ItemSelection) {
      removeFromArray(panes, AppPaneId.Items)
    }

    if (
      panes.includes(AppPaneId.Navigation) &&
      this.navigationPaneExplicitelyCollapsed &&
      layout !== PaneLayout.TagSelection
    ) {
      removeFromArray(panes, AppPaneId.Navigation)
    }

    this.replacePanes(panes)
  }

  replacePanes = (panes: AppPaneId[]) => {
    log(LoggingDomain.Panes, 'Replacing panes', panes)

    this.panes = this.isInMobileView ? panes : dockAssistantPaneToRight(panes, this.panes.includes(AppPaneId.Assistant))
  }

  presentPane = (pane: AppPaneId) => {
    log(LoggingDomain.Panes, 'Presenting pane', pane)

    if (pane === AppPaneId.Assistant) {
      this.persistAssistantPaneOpen(true)
    }

    if (!this.isInMobileView && this.panes.includes(AppPaneId.Assistant)) {
      this.panes = presentPaneBeforeDockedAssistant(this.panes, pane)
      return
    }

    if (pane === this.currentPane) {
      return
    }

    if (pane === AppPaneId.Items && this.currentPane === AppPaneId.Editor) {
      this.dismissLastPane()
      return
    }

    if (this.currentPane !== pane) {
      this.panes.push(pane)
    }
  }

  insertPaneAtIndex = (pane: AppPaneId, index: number) => {
    log(LoggingDomain.Panes, 'Inserting pane', pane, 'at index', index)

    if (!this.isInMobileView && this.panes.includes(AppPaneId.Assistant)) {
      this.panes = insertPaneBeforeDockedAssistant(this.panes, pane, index)
      return
    }

    this.panes.splice(index, 0, pane)
  }

  dismissLastPane = (): AppPaneId | undefined => {
    log(LoggingDomain.Panes, 'Dismissing last pane')

    const dismissedPane = this.panes.pop()
    if (dismissedPane === AppPaneId.Assistant) {
      this.persistAssistantPaneOpen(false)
    }

    return dismissedPane
  }

  removePane = (pane: AppPaneId) => {
    log(LoggingDomain.Panes, 'Removing pane', pane)

    if (pane === AppPaneId.Assistant) {
      this.panes = this.panes.filter((candidate) => candidate !== AppPaneId.Assistant)
      this.persistAssistantPaneOpen(false)
      return
    }

    removeFromArray(this.panes, pane)
  }

  popToPane = (pane: AppPaneId) => {
    log(LoggingDomain.Panes, 'Popping to pane', pane)

    if (!this.isInMobileView && this.panes.includes(AppPaneId.Assistant) && pane !== AppPaneId.Assistant) {
      const nonAssistantPanes = this.panes.filter((candidate) => candidate !== AppPaneId.Assistant)
      const paneIndex = nonAssistantPanes.lastIndexOf(pane)
      if (paneIndex >= 0) {
        this.panes = [...nonAssistantPanes.slice(0, paneIndex + 1), AppPaneId.Assistant]
        return
      }
    }

    let index = this.panes.length - 1
    while (index >= 0) {
      if (this.panes[index] === pane) {
        break
      }

      this.dismissLastPane()
      index--
    }
  }

  /**
   * Standard Red Notes: opens a full-column pane view as a tab in the editor tab
   * bar. Idempotent per pane (a pane can only have one tab). Makes the editor
   * column visible so the tab content shows (important on mobile).
   */
  openPaneTab = (paneId: AppPaneId) => {
    const meta = TABBABLE_PANES.find((entry) => entry.paneId === paneId)
    if (!meta) {
      return
    }

    if (!this.viewTabs.some((tab) => tab.id === paneId)) {
      this.viewTabs = [...this.viewTabs, { id: paneId, kind: 'pane', paneId, title: meta.title, icon: meta.icon }]
    }

    this.activeViewTabId = paneId
    this.presentPane(AppPaneId.Editor)
  }

  /**
   * Standard Red Notes: opens a note's conflict resolution UI as a tab in the
   * editor tab bar (side-by-side current vs conflicted copy) instead of an inline
   * modal. Idempotent per note (one conflict tab per note). Makes the editor
   * column visible so the tab content shows.
   */
  openConflictTab = (noteUuid: string, title: string) => {
    const id = `conflict:${noteUuid}`

    if (!this.viewTabs.some((tab) => tab.id === id)) {
      this.viewTabs = [...this.viewTabs, { id, kind: 'conflict', noteUuid, title, icon: 'merge' }]
    }

    this.activeViewTabId = id
    this.presentPane(AppPaneId.Editor)
  }

  /**
   * Standard Red Notes: opens a fresh empty placeholder tab in the editor tab bar
   * and makes it active. Multiple empty tabs can coexist, so each gets a unique id
   * from an incrementing instance counter. Makes the editor column visible so the
   * tab content shows (important on mobile).
   */
  openEmptyTab = () => {
    const id = `empty:${++this.emptyTabCounter}`

    this.viewTabs = [...this.viewTabs, { id, kind: 'empty', title: 'New tab', icon: 'add' }]

    this.activeViewTabId = id
    this.presentPane(AppPaneId.Editor)
  }

  closeViewTab = (id: string) => {
    this.viewTabs = this.viewTabs.filter((tab) => tab.id !== id)
    if (this.activeViewTabId === id) {
      this.activeViewTabId = undefined
    }
  }

  setActiveViewTab = (id: string | undefined) => {
    this.activeViewTabId = id
    if (id) {
      this.presentPane(AppPaneId.Editor)
    }
  }

  get activeViewTab(): ViewTab | undefined {
    return this.viewTabs.find((tab) => tab.id === this.activeViewTabId)
  }

  toggleListPane = () => {
    if (this.panes.includes(AppPaneId.Items)) {
      this.removePane(AppPaneId.Items)
      this.preferences.setLocalValue(LocalPrefKey.ListPaneCollapsed, true)
    } else {
      if (this.panes.includes(AppPaneId.Navigation)) {
        this.insertPaneAtIndex(AppPaneId.Items, 1)
      } else {
        this.insertPaneAtIndex(AppPaneId.Items, 0)
      }
      this.preferences.setLocalValue(LocalPrefKey.ListPaneCollapsed, false)
    }
  }

  /**
   * Collapse or restore the navigation sidebar. It writes only the collapse
   * state, never the mini one, which is what makes mini a third STATE rather
   * than a mode that competes with these two: collapsing a rail and expanding it
   * again gives the rail back, because the stored "render as a rail" answer was
   * never part of "is this pane on screen".
   */
  toggleNavigationPane = () => {
    if (this.panes.includes(AppPaneId.Navigation)) {
      this.removePane(AppPaneId.Navigation)
      this.preferences.setLocalValue(LocalPrefKey.NavigationPaneCollapsed, true)
    } else {
      this.insertPaneAtIndex(AppPaneId.Navigation, 0)
      this.preferences.setLocalValue(LocalPrefKey.NavigationPaneCollapsed, false)
    }
  }

  get isListPaneCollapsed() {
    return !this.panes.includes(AppPaneId.Items)
  }

  get isNavigationPaneCollapsed() {
    return !this.panes.includes(AppPaneId.Navigation)
  }

  setFocusModeEnabled = (enabled: boolean): void => {
    this.focusModeEnabled = enabled

    if (enabled) {
      document.body.classList.add(FOCUS_MODE_CLASS_NAME)
      return
    }

    if (document.body.classList.contains(FOCUS_MODE_CLASS_NAME)) {
      document.body.classList.add(DISABLING_FOCUS_MODE_CLASS_NAME)
      document.body.classList.remove(FOCUS_MODE_CLASS_NAME)

      setTimeout(() => {
        document.body.classList.remove(DISABLING_FOCUS_MODE_CLASS_NAME)
      }, FOCUS_MODE_ANIMATION_DURATION)
    }
  }

  toggleFocusMode = () => {
    this.setFocusModeEnabled(!this.focusModeEnabled)
  }
}
