import { ApplicationStageChangedEventPayload } from './../Event/ApplicationStageChangedEventPayload'
import { ApplicationEvent } from './../Event/ApplicationEvent'
import { InternalEventInterface } from './../Internal/InternalEventInterface'
import { InternalEventHandlerInterface } from './../Internal/InternalEventHandlerInterface'
import { ApplicationStage } from '../Application/ApplicationStage'
import { SingletonManagerInterface } from '../Singleton/SingletonManagerInterface'
import { SyncEvent } from '../Event/SyncEvent'
import { SessionsClientInterface } from '../Session/SessionsClientInterface'
import { ItemManagerInterface } from '../Item/ItemManagerInterface'
import { SyncServiceInterface } from '../Sync/SyncServiceInterface'
import {
  ContactPublicKeySet,
  FillItemContent,
  TrustedContact,
  TrustedContactContent,
  TrustedContactContentSpecialized,
  TrustedContactInterface,
} from '@standardnotes/models'
import { ContentType } from '@standardnotes/domain-core'

const SelfContactName = 'Me'

export class SelfContactManager implements InternalEventHandlerInterface {
  public selfContact?: TrustedContactInterface

  private pendingCreation?: Promise<TrustedContactInterface | undefined>
  private eventDisposers: (() => void)[] = []

  constructor(
    sync: SyncServiceInterface,
    items: ItemManagerInterface,
    private session: SessionsClientInterface,
    private singletons: SingletonManagerInterface,
  ) {
    this.eventDisposers.push(
      sync.addEventObserver((event) => {
        if (event === SyncEvent.LocalDataIncrementalLoad) {
          this.loadSelfContactFromDatabase()
        }

        if (event === SyncEvent.SyncCompletedWithAllItemsUploaded) {
          void this.getOrCreateSelfContact()
        }
      }),
    )

    this.eventDisposers.push(
      items.addObserver(ContentType.TYPES.TrustedContact, () => {
        const updatedReference = this.singletons.findSingleton<TrustedContact>(
          ContentType.TYPES.TrustedContact,
          TrustedContact.singletonPredicate,
        )
        if (updatedReference) {
          this.selfContact = updatedReference
        }
      }),
    )
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    if (event.type === ApplicationEvent.ApplicationStageChanged) {
      const stage = (event.payload as ApplicationStageChangedEventPayload).stage
      if (stage === ApplicationStage.LoadedDatabase_12) {
        this.loadSelfContactFromDatabase()
      }
    }
  }

  private loadSelfContactFromDatabase(): void {
    if (this.selfContact) {
      return
    }

    this.selfContact = this.singletons.findSingleton<TrustedContactInterface>(
      ContentType.TYPES.TrustedContact,
      TrustedContact.singletonPredicate,
    )
  }

  /**
   * Resolves the account's own `isMe` TrustedContact, creating it if the account does not have one
   * yet. Every collaboration path depends on it: an invite delegates it to the invitee, and the
   * Vault Members list resolves the current user's own membership through it.
   *
   * This used to be gated behind `InternalFeature.Vaults`, which ONLY `DevMode` ever enables and
   * which a shipped build can therefore never satisfy (the web image builds with webpack
   * `mode: 'production'`, so `isDev` folds to false and `DevMode` is never constructed). The client
   * meanwhile offers the whole vaults UI to admins and to SharedVaults-entitled accounts
   * (`FeaturesController.isVaultsEnabled`), so a shipped build could create a shared vault and then
   * fail every invite with "me contact not found" while rendering the owner's OWN membership as a
   * bare uuid labelled "Untrusted". Collaboration capability — signed in, with an account key pair
   * — is the only precondition that actually matters, and it is checked below.
   *
   * Creating the contact late is safe: `contactUuid` is the server-side user uuid, so it matches any
   * membership already recorded for this account by construction, and `publicKeySet` is read from
   * the account's CURRENT key pair, which is exactly what an invite must delegate. The contact is a
   * singleton (`TrustedContact.singletonPredicate`), so an existing one synced from another client
   * is adopted rather than duplicated.
   */
  async getOrCreateSelfContact(): Promise<TrustedContactInterface | undefined> {
    this.loadSelfContactFromDatabase()

    if (this.selfContact) {
      return this.selfContact
    }

    if (!this.session || !this.session.isSignedIn()) {
      return undefined
    }

    if (this.session.isUserMissingKeyPair()) {
      return undefined
    }

    if (!this.pendingCreation) {
      // Hold the in-flight promise rather than a boolean so concurrent callers await the same
      // creation instead of racing it or giving up, and so a throw cannot wedge creation for the
      // rest of the session the way the previous `isReloadingSelfContact` flag could.
      this.pendingCreation = this.createSelfContact().finally(() => {
        this.pendingCreation = undefined
      })
    }

    return this.pendingCreation
  }

  private async createSelfContact(): Promise<TrustedContactInterface | undefined> {
    const content: TrustedContactContentSpecialized = {
      name: SelfContactName,
      isMe: true,
      contactUuid: this.session.getSureUser().uuid,
      publicKeySet: ContactPublicKeySet.FromJson({
        encryption: this.session.getPublicKey(),
        signing: this.session.getSigningPublicKey(),
        timestamp: new Date(),
      }),
    }

    this.selfContact = await this.singletons.findOrCreateSingleton<TrustedContactContent, TrustedContact>(
      TrustedContact.singletonPredicate,
      ContentType.TYPES.TrustedContact,
      FillItemContent<TrustedContactContent>(content),
    )

    return this.selfContact
  }

  deinit() {
    this.eventDisposers.forEach((disposer) => disposer())
    ;(this.session as unknown) = undefined
    ;(this.singletons as unknown) = undefined
  }
}
