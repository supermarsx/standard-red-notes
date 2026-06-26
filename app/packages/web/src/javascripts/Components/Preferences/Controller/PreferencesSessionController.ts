import { action, makeAutoObservable, observable } from 'mobx'
import { WebApplication } from '@/Application/WebApplication'
import { PackageProvider } from '../Panes/Plugins/PackageProvider'
import { securityPrefsHasBubble } from '../Panes/Security/securityPrefsHasBubble'
import { PreferencePaneId, StatusServiceEvent } from '@standardnotes/services'
import { isDesktopApplication } from '@/Utils'
import { PreferencesMenuItem } from './PreferencesMenuItem'
import { SelectableMenuItem } from './SelectableMenuItem'
import { PREFERENCES_MENU_ITEMS, READY_PREFERENCES_MENU_ITEMS } from './MenuItems'

/**
 * Unlike PreferencesController, the PreferencesSessionController is ephemeral and bound to a single opening of the
 * Preferences menu. It is created and destroyed each time the menu is opened and closed.
 */
export class PreferencesSessionController {
  private _selectedPane: PreferencePaneId = 'account'
  private _menu: PreferencesMenuItem[]
  private _extensionLatestVersions: PackageProvider = new PackageProvider(new Map())

  constructor(
    private application: WebApplication,
    private readonly _enableUnfinishedFeatures: boolean,
  ) {
    const menuItems = this._enableUnfinishedFeatures
      ? PREFERENCES_MENU_ITEMS.slice()
      : READY_PREFERENCES_MENU_ITEMS.slice()

    if (application.featuresController.isVaultsEnabled()) {
      menuItems.push({ id: 'vaults', label: 'Vaults', icon: 'safe-square', order: 5 })

      // Standard Red Notes: Sharing overview pane — surfaces what's shared,
      // collaborators, live presence, and pending invites. Complements (does not
      // replace) the Vaults pane's full contact/invite management.
      menuItems.push({ id: 'sharing', label: 'Sharing', icon: 'user-switch', order: 5 })
    }

    // Standard Red Notes: the Admin pane is only added to the menu for users who
    // carry the INTERNAL_TEAM_USER role. Non-admins never see the entry, and the
    // server independently re-checks the role on every admin endpoint.
    if (application.featuresController.isAdminUser()) {
      menuItems.push({ id: 'admin', label: 'Admin', icon: 'server', order: 10 })
    }

    if (isDesktopApplication()) {
      menuItems.push({ id: 'home-server', label: 'Home Server', icon: 'server', order: 5 })
    }

    // Standard Red Notes: public read-only share links management pane.
    menuItems.push({ id: 'shares', label: 'Share Links', icon: 'link', order: 9 })

    // Standard Red Notes: survivor switch (dead man's switch) management pane.
    menuItems.push({ id: 'survivor-switch', label: 'Survivor Switch', icon: 'pencil-off', order: 9 })

    // Standard Red Notes: sync conflict review & resolution pane.
    menuItems.push({ id: 'conflicts', label: 'Sync Conflicts', icon: 'sync', order: 9 })

    // Standard Red Notes: Sync control pane — overview of synced vs. local-only
    // items, the list of what's kept on this device, and selective-sync config.
    menuItems.push({ id: 'sync', label: 'Sync', icon: 'sync', order: 9 })

    // Standard Red Notes: recently-opened notes history pane.
    menuItems.push({ id: 'recent-notes', label: 'Recent Notes', icon: 'history', order: 9 })

    // Standard Red Notes: background search-index controls (enable/disable,
    // start/stop, scheduler).
    menuItems.push({ id: 'search-index', label: 'Search Index', icon: 'search', order: 9 })

    // Standard Red Notes: gamified Achievements pane (badges derived from usage).
    menuItems.push({ id: 'achievements', label: 'Achievements', icon: 'star', order: 9 })

    // Standard Red Notes: Storage pane — where local disk space is going, sized
    // off the main thread by a progressive IndexedDB-scanning worker.
    menuItems.push({ id: 'storage', label: 'Storage', icon: 'server', order: 9 })

    this._menu = menuItems.sort((a, b) => a.order - b.order)

    this.loadLatestVersions()

    makeAutoObservable<
      PreferencesSessionController,
      | '_selectedPane'
      | '_twoFactorAuth'
      | '_extensionPanes'
      | '_extensionLatestVersions'
      | 'loadLatestVersions'
      | 'updateMenuBubbleCounts'
    >(this, {
      _twoFactorAuth: observable,
      _selectedPane: observable,
      _extensionPanes: observable.ref,
      _extensionLatestVersions: observable.ref,
      loadLatestVersions: action,
      updateMenuBubbleCounts: action,
    })

    this.application.status.addEventObserver((event) => {
      if (event === StatusServiceEvent.PreferencesBubbleCountChanged) {
        this.updateMenuBubbleCounts()
      }
    })
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

  get extensionsLatestVersions(): PackageProvider {
    return this._extensionLatestVersions
  }

  get menuItems(): SelectableMenuItem[] {
    const menuItems = this._menu.map((preference) => {
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
    return this._menu.find((item) => item.id === this._selectedPane)
  }

  get selectedPaneId(): PreferencePaneId {
    if (this.selectedMenuItem != undefined) {
      return this.selectedMenuItem.id
    }

    return 'account'
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
