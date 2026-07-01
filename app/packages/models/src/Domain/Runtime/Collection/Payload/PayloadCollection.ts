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
  /**
   * Integrity is presence-only BY PROTOCOL DESIGN. Each payload here is just
   * `{ uuid, updated_at_timestamp }` for every non-deleted, non-local-only item — never any
   * content hash. The syncing-server computes the SAME scheme (see syncing-server
   * UseCase/Syncing/CheckIntegrity: it only compares uuid presence and updated_at_timestamp,
   * never content), so the two sides only agree because both hash exactly these two fields.
   *
   * Consequences (intentional, not bugs in this method):
   *  - Content divergence with a MATCHING updated_at_timestamp is NOT detected.
   *  - Deletions are NOT covered (deleted items are excluded on both client and server).
   *
   * Do NOT add content to this hash unilaterally: the server's hash is unchanged, so it would
   * make every integrity check mismatch forever. Including content requires a coordinated,
   * versioned client + server change.
   */
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
