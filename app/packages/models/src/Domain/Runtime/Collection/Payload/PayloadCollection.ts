import { FullyFormedPayloadInterface } from './../../../Abstract/Payload/Interfaces/UnionTypes'
import { EncryptedPayloadInterface } from '../../../Abstract/Payload/Interfaces/EncryptedPayload'
import { CollectionInterface } from '../CollectionInterface'
import { DecryptedPayloadInterface } from '../../../Abstract/Payload/Interfaces/DecryptedPayload'
import { IntegrityPayload } from '@standardnotes/responses'
import { Collection } from '../Collection'
import { DeletedPayloadInterface } from '../../../Abstract/Payload'
import { PayloadIsLocalOnly } from '../../../Utilities/Payload/PayloadIsLocalOnly'

export class PayloadCollection<P extends FullyFormedPayloadInterface = FullyFormedPayloadInterface>
  extends Collection<P, DecryptedPayloadInterface, EncryptedPayloadInterface, DeletedPayloadInterface>
  implements CollectionInterface
{
  public integrityPayloads(): IntegrityPayload[] {
    const nondeletedElements = this.nondeletedElements()

    /**
     * Local-only items never reach the server, so they must be excluded from the integrity
     * payload set. Otherwise the local account hash would never match the server's, leaving
     * the client permanently "out of sync" and repeatedly attempting to reconcile an item
     * the server does not (and should not) have.
     */
    return nondeletedElements
      .filter((item) => !PayloadIsLocalOnly(item))
      .map((item) => ({
        uuid: item.uuid,
        updated_at_timestamp: item.serverUpdatedAtTimestamp as number,
      }))
  }
}
