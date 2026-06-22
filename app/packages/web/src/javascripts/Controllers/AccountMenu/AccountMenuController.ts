import { destroyAllObjectProperties } from '@/Utils'
import { action, computed, makeObservable, observable, runInAction } from 'mobx'
import {
  ApplicationEvent,
  ContentType,
  GetHost,
  InternalEventBusInterface,
  InternalEventHandlerInterface,
  InternalEventInterface,
  ItemManagerInterface,
  SNNote,
  SNTag,
} from '@standardnotes/snjs'
import { AccountMenuPane } from '@/Components/AccountMenu/AccountMenuPane'
import { AbstractViewController } from '../Abstract/AbstractViewController'

export class AccountMenuController extends AbstractViewController implements InternalEventHandlerInterface {
  show = false
  signingOut = false
  otherSessionsSignOut = false
  server: string | undefined = undefined
  notesAndTags: (SNNote | SNTag)[] = []
  isEncryptionEnabled = false
  encryptionStatusString = ''
  isBackupEncrypted = false
  showSignIn = false
  deletingAccount = false
  showRegister = false
  currentPane = AccountMenuPane.GeneralMenu

  /**
   * True when the server session became invalid (expired/rejected — NOT a clean
   * server-side revoke that wipes local data) and the user dismissed the
   * automatic re-login prompt. While this is set, the app must NOT keep
   * re-popping the sign-in challenge; instead the footer surfaces a clickable
   * "Login needed" status. Cleared on a successful sign-in (or when the user
   * deliberately re-opens sign-in from the status).
   */
  reloginPromptDismissed = false

  override deinit() {
    super.deinit()
    ;(this.notesAndTags as unknown) = undefined

    destroyAllObjectProperties(this)
  }

  constructor(
    private items: ItemManagerInterface,
    private _getHost: GetHost,
    eventBus: InternalEventBusInterface,
  ) {
    super(eventBus)

    makeObservable(this, {
      show: observable,
      signingOut: observable,
      otherSessionsSignOut: observable,
      server: observable,
      notesAndTags: observable,
      isEncryptionEnabled: observable,
      encryptionStatusString: observable,
      isBackupEncrypted: observable,
      showSignIn: observable,
      deletingAccount: observable,
      showRegister: observable,
      currentPane: observable,
      reloginPromptDismissed: observable,

      setShow: action,
      toggleShow: action,
      setSigningOut: action,
      setIsEncryptionEnabled: action,
      setEncryptionStatusString: action,
      setIsBackupEncrypted: action,
      setOtherSessionsSignOut: action,
      setCurrentPane: action,
      setServer: action,
      setDeletingAccount: action,
      setReloginPromptDismissed: action,
      openSignIn: action,

      notesAndTagsCount: computed,
    })

    eventBus.addEventHandler(this, ApplicationEvent.Launched)

    this.disposers.push(
      this.items.streamItems([ContentType.TYPES.Note, ContentType.TYPES.Tag], () => {
        runInAction(() => {
          this.notesAndTags = this.items.getItems([ContentType.TYPES.Note, ContentType.TYPES.Tag])
        })
      }),
    )
  }
  async handleEvent(event: InternalEventInterface): Promise<void> {
    switch (event.type) {
      case ApplicationEvent.Launched: {
        runInAction(() => {
          this.setServer(this._getHost.execute().getValue())
        })
        break
      }
    }
  }

  setShow = (show: boolean): void => {
    this.show = show
    if (show) {
      this.setCurrentPane(AccountMenuPane.GeneralMenu)
    }
  }

  closeAccountMenu = (): void => {
    this.setShow(false)
  }

  setSigningOut = (signingOut: boolean): void => {
    this.signingOut = signingOut
  }

  setServer = (server: string | undefined): void => {
    this.server = server
  }

  setIsEncryptionEnabled = (isEncryptionEnabled: boolean): void => {
    this.isEncryptionEnabled = isEncryptionEnabled
  }

  setEncryptionStatusString = (encryptionStatusString: string): void => {
    this.encryptionStatusString = encryptionStatusString
  }

  setIsBackupEncrypted = (isBackupEncrypted: boolean): void => {
    this.isBackupEncrypted = isBackupEncrypted
  }

  setShowSignIn = (showSignIn: boolean): void => {
    this.showSignIn = showSignIn
  }

  setShowRegister = (showRegister: boolean): void => {
    this.showRegister = showRegister
  }

  toggleShow = (): void => {
    if (this.show) {
      this.closeAccountMenu()
    } else {
      this.setShow(true)
    }
  }

  setOtherSessionsSignOut = (otherSessionsSignOut: boolean): void => {
    this.otherSessionsSignOut = otherSessionsSignOut
  }

  setCurrentPane = (pane: AccountMenuPane): void => {
    this.currentPane = pane
  }

  setDeletingAccount = (deletingAccount: boolean): void => {
    this.deletingAccount = deletingAccount
  }

  setReloginPromptDismissed = (dismissed: boolean): void => {
    this.reloginPromptDismissed = dismissed
  }

  /**
   * Opens the account menu directly on the Sign In pane. Used both by the
   * "Login needed" footer status (click-to-resume) and any other programmatic
   * sign-in entry point. Clears the dismissed flag so the status returns to its
   * normal state once the user is acting on the prompt.
   */
  openSignIn = (): void => {
    this.reloginPromptDismissed = false
    this.setShow(true)
    this.setCurrentPane(AccountMenuPane.SignIn)
  }

  get notesAndTagsCount(): number {
    return this.notesAndTags.length
  }
}
