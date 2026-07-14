import { action, makeAutoObservable, observable } from 'mobx'
import { WebApplication } from '@/Application/WebApplication'
import { PackageProvider } from '../Panes/Plugins/PackageProvider'
import { securityPrefsHasBubble } from '../Panes/Security/securityPrefsHasBubble'
import { PreferencePaneId, StatusServiceEvent } from '@standardnotes/services'
import { ApplicationEvent, PrefKey, PrefDefaults } from '@standardnotes/snjs'
import { isDesktopApplication } from '@/Utils'
import { PreferencesMenuItem } from './PreferencesMenuItem'
import { SelectableMenuItem } from './SelectableMenuItem'
import { PREFERENCES_MENU_ITEMS, READY_PREFERENCES_MENU_ITEMS } from './MenuItems'
import { parseSelfServeInviteState } from '../Panes/Invite/inviteLinks'

/**
 * Unlike PreferencesController, the PreferencesSessionController is ephemeral and bound to a single opening of the
 * Preferences menu. It is created and destroyed each time the menu is opened and closed.
 */
export class PreferencesSessionController {
  private _selectedPane: PreferencePaneId = 'account'
  private _menu: PreferencesMenuItem[]
  private _extensionLatestVersions: PackageProvider = new PackageProvider(new Map())

  // Standard Red Notes: the "What's New" entry is hidden unless the user opts in
  // (Preferences → General → Updates). Kept as an observable mirror of the pref
  // so toggling it while Preferences is open adds/removes the entry immediately.
  private _showWhatsNew: boolean

  constructor(
    private application: WebApplication,
    private readonly _enableUnfinishedFeatures: boolean,
  ) {
    const menuItems = this._enableUnfinishedFeatures
      ? PREFERENCES_MENU_ITEMS.slice()
      : READY_PREFERENCES_MENU_ITEMS.slice()

    if (application.featuresController.isVaultsEnabled()) {
      menuItems.push({ id: 'vaults', label: 'Vaults', icon: 'safe-square', order: 5 })
    }

    // Standard Red Notes: Sharing pane — "Shared vaults" collaboration overview
    // PLUS the "Share links" public-link manager, as subtabs. Registered
    // unconditionally (NOT gated on isVaultsEnabled) so the Share Links subtab
    // stays reachable even when vaults are disabled; the Shared-vaults subtab
    // keeps its own sign-in / entitlement / protocol gating internally.
    menuItems.push({ id: 'sharing', label: 'Sharing', icon: 'user-switch', order: 9 })

    // Standard Red Notes: the Admin pane is only added to the menu for users who
    // carry the ADMIN_USER role. Non-admins never see the entry, and the
    // server independently re-checks the role on every admin endpoint.
    if (application.featuresController.isAdminUser()) {
      // wide: the Admin pane hosts big tables (users list, audit log, logs) and
      // gets a double-width content column via PreferencesPane.
      menuItems.push({ id: 'admin', label: 'Admin', icon: 'tune', order: 10, wide: true })
    }

    if (isDesktopApplication()) {
      menuItems.push({ id: 'home-server', label: 'Home Server', icon: 'server', order: 5 })
    }

    // Standard Red Notes: survivor switch (dead man's switch) management pane.
    menuItems.push({ id: 'survivor-switch', label: 'Survivor Switch', icon: 'pencil-off', order: 9 })

    // Standard Red Notes: Sync control pane — overview of synced vs. local-only
    // items, the list of what's kept on this device, selective-sync config, and
    // sync conflict review & resolution (merged in from the former "Sync Conflicts"
    // pane so all sync controls live in one section).
    menuItems.push({ id: 'sync', label: 'Sync', icon: 'sync', order: 9 })

    // Standard Red Notes: recently-opened notes history pane.
    menuItems.push({ id: 'recent-notes', label: 'Recent Notes', icon: 'history', order: 9 })

    // Standard Red Notes: Search & Indexing pane — background indexer controls
    // (enable/disable, start/stop), scheduler modes (on-change/idle/interval/manual),
    // manual purge, inclusion/exclusion scope, and index limits + search prefs.
    menuItems.push({ id: 'searchIndexing', label: 'Search & Indexing', icon: 'search', order: 9 })

    // Standard Red Notes: gamified Achievements pane (badges derived from usage).
    menuItems.push({ id: 'achievements', label: 'Achievements', icon: 'star', order: 9 })

    // Standard Red Notes: Storage pane — where local disk space is going, sized
    // off the main thread by a progressive IndexedDB-scanning worker.
    menuItems.push({ id: 'storage', label: 'Storage', icon: 'server', order: 9 })

    this._menu = menuItems.sort((a, b) => a.order - b.order)

    this._showWhatsNew = application.getPreference(
      PrefKey.ShowWhatsNewSection,
      PrefDefaults[PrefKey.ShowWhatsNewSection],
    )

    this.loadLatestVersions()

    // Standard Red Notes: the user-facing self-serve Invite pane is added to the
    // menu only when the server enables referral invites (registration.
    // invitesPerUser > 0). There is no synchronous client-side signal for that,
    // so probe the user's own invite links once (the same call the pane makes)
    // and add the menu entry when the feature is available. Async, like
    // loadLatestVersions — the entry appears as soon as the probe resolves.
    this.loadSelfServeInvites()

    makeAutoObservable<
      PreferencesSessionController,
      | '_selectedPane'
      | '_twoFactorAuth'
      | '_extensionPanes'
      | '_extensionLatestVersions'
      | '_showWhatsNew'
      | 'loadLatestVersions'
      | 'loadSelfServeInvites'
      | 'addInviteMenuItem'
      | 'updateMenuBubbleCounts'
      | 'updateShowWhatsNew'
    >(this, {
      _twoFactorAuth: observable,
      _selectedPane: observable,
      _extensionPanes: observable.ref,
      _extensionLatestVersions: observable.ref,
      _showWhatsNew: observable,
      loadLatestVersions: action,
      loadSelfServeInvites: action,
      addInviteMenuItem: action,
      updateMenuBubbleCounts: action,
      updateShowWhatsNew: action,
    })

    this.application.status.addEventObserver((event) => {
      if (event === StatusServiceEvent.PreferencesBubbleCountChanged) {
        this.updateMenuBubbleCounts()
      }
    })

    // React to the ShowWhatsNewSection pref changing while Preferences is open
    // (the toggle lives inside General → Updates), so the menu entry appears or
    // disappears without a reload.
    this.application.addEventObserver(async () => {
      this.updateShowWhatsNew()
    }, ApplicationEvent.PreferencesChanged)
  }

  private updateShowWhatsNew(): void {
    this._showWhatsNew = this.application.getPreference(
      PrefKey.ShowWhatsNewSection,
      PrefDefaults[PrefKey.ShowWhatsNewSection],
    )
  }

  /** The menu with opt-in entries (currently only "What's New") filtered out when hidden. */
  private get visibleMenu(): PreferencesMenuItem[] {
    if (this._showWhatsNew) {
      return this._menu
    }
    return this._menu.filter((item) => item.id !== 'whats-new')
  }

  private updateMenuBubbleCounts(): void {
    this._menu = this._menu.map((item) => {
      return {
        ...item,
        bubbleCount: this.application.status.getPreferencesBubbleCount(item.id),
      }
    })
  }

  private loadLatestVersions(): void {
    PackageProvider.load()
      .then((versions) => {
        if (versions) {
          this._extensionLatestVersions = versions
        }
      })
      .catch(console.error)
  }

  /**
   * Probe the server's self-serve invite availability and register the "Invite
   * friends" menu entry when it is enabled. Uses the same listMyInviteLinks()
   * call the pane makes; parseSelfServeInviteState() reports `enabled === false`
   * for a non-2xx response or an explicit `invitesPerUser: 0`, so a disabled
   * server never gets the entry.
   */
  private loadSelfServeInvites(): void {
    this.application.legacyApi
      .listMyInviteLinks()
      .then((response) => {
        if (parseSelfServeInviteState(response).enabled) {
          this.addInviteMenuItem()
        }
      })
      .catch(console.error)
  }

  private addInviteMenuItem(): void {
    if (this._menu.some((item) => item.id === 'invite')) {
      return
    }
    const inviteMenuItem: PreferencesMenuItem = { id: 'invite', label: 'Invite friends', icon: 'user-add', order: 9 }
    this._menu = [...this._menu, inviteMenuItem].sort((a, b) => a.order - b.order)
  }

  get extensionsLatestVersions(): PackageProvider {
    return this._extensionLatestVersions
  }

  get menuItems(): SelectableMenuItem[] {
    const menuItems = this.visibleMenu.map((preference) => {
      const item: SelectableMenuItem = {
        ...preference,
        selected: preference.id === this._selectedPane,
        bubbleCount: this.application.status.getPreferencesBubbleCount(preference.id),
        hasErrorIndicator: this.sectionHasBubble(preference.id),
      }
      return item
    })

    return menuItems
  }

  get selectedMenuItem(): PreferencesMenuItem | undefined {
    // Looks up against the VISIBLE menu so that a hidden pane (e.g. 'whats-new'
    // while its opt-in pref is off) can never be selected — selectedPaneId then
    // falls back to 'account', which also gates any programmatic deep-link.
    return this.visibleMenu.find((item) => item.id === this._selectedPane)
  }

  get selectedPaneId(): PreferencePaneId {
    if (this.selectedMenuItem != undefined) {
      return this.selectedMenuItem.id
    }

    return 'account'
  }

  /** True when the currently selected pane requested a double-width content column. */
  get isSelectedPaneWide(): boolean {
    return this.selectedMenuItem?.wide === true
  }

  selectPane = (key: PreferencePaneId) => {
    this._selectedPane = key
  }

  sectionHasBubble(id: PreferencePaneId): boolean {
    if (id === 'security') {
      return securityPrefsHasBubble(this.application)
    }

    return false
  }
}
