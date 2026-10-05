import { SyncServiceInterface } from '../../Sync/SyncServiceInterface'
import { MutatorClientInterface } from '../../Mutator/MutatorClientInterface'
import {
  FillItemContent,
  MutationType,
  PayloadEmitSource,
  TrustedContactContent,
  TrustedContactContentSpecialized,
  TrustedContactInterface,
  TrustedContactMutator,
} from '@standardnotes/models'
import { FindContact } from './FindContact'
import { ContentType, Result, UseCaseInterface } from '@standardnotes/domain-core'

/**
 * Applies a contact record received from a trusted contact (an AsymmetricMessage ContactShare).
 *
 * It used to call `TrustedContactMutator.replacePublicKeySet`, which overwrites the whole key set
 * with whatever the sender supplied and so DISCARDS the `previousKeySet` chain. That chain is what
 * `TrustedContact.getTrustStatusForSigningPublicKey` walks to recognise a key a contact has since
 * rotated away from: destroying it silently turns every item this account already holds that was
 * signed with a superseded key from "signed with a non-current key" into "not trusted", and it lets
 * one sender erase the rotation history another sender established.
 *
 * It now appends instead, exactly as EditContact does for the SenderKeypairChanged path: a key set
 * that differs from the current one is pushed with the current one as its predecessor, and an
 * identical one is left alone so that a repeated share does not grow the chain. Rotation still
 * propagates; history survives.
 */
export class ReplaceContactData implements UseCaseInterface<TrustedContactInterface> {
  constructor(
    private mutator: MutatorClientInterface,
    private sync: SyncServiceInterface,
    private findContact: FindContact,
  ) {}

  async execute(data: TrustedContactContentSpecialized): Promise<Result<TrustedContactInterface>> {
    const contactResult = this.findContact.execute({ userUuid: data.contactUuid })
    if (contactResult.isFailed()) {
      const newContact = await this.mutator.createItem<TrustedContactInterface>(
        ContentType.TYPES.TrustedContact,
        FillItemContent<TrustedContactContent>(data),
        true,
      )

      await this.sync.sync()

      return Result.ok(newContact)
    }

    const existingContact = contactResult.getValue()
    if (existingContact.isMe) {
      return Result.fail('Cannot replace data for me contact')
    }

    const updatedContact = await this.mutator.changeItem<TrustedContactMutator, TrustedContactInterface>(
      existingContact,
      (mutator) => {
        mutator.name = data.name

        const incomingKeySet = data.publicKeySet
        const currentKeySet = existingContact.publicKeySet

        if (
          incomingKeySet.encryption !== currentKeySet.encryption ||
          incomingKeySet.signing !== currentKeySet.signing
        ) {
          mutator.addPublicKey({
            encryption: incomingKeySet.encryption,
            signing: incomingKeySet.signing,
          })
        }
      },
      MutationType.UpdateUserTimestamps,
      PayloadEmitSource.RemoteRetrieved,
    )

    await this.sync.sync()

    return Result.ok(updatedContact)
  }
}
