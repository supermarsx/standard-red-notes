import { ItemContent } from '../../Content/ItemContent'
import { DecryptedTransferPayload } from '../../TransferPayload/Interfaces/DecryptedTransferPayload'
import { DecryptedPayloadInterface } from '../Interfaces/DecryptedPayload'
import { DecryptedPayload } from '../Implementations/DecryptedPayload'
import { isDecryptedPayload } from '../Interfaces/TypeCheck'
import { PayloadInterface } from '../Interfaces/PayloadInterface'

/**
 * LAZY-DECRYPT / METADATA-RETENTION SUPPORT
 * -----------------------------------------
 * A "lite" payload is a fully-formed DECRYPTED payload whose large body field(s) (note `text`,
 * and any future bulky content fields) have been STRIPPED to keep resident heap small when an
 * account holds a very large number of notes (~100k). The metadata projection that the
 * list/sort/filter/row code needs is retained verbatim, so the UI behaves identically.
 *
 * SAFETY CONTRACT (data-loss prevention):
 *   A lite payload represents an INCOMPLETE view of the real, on-disk encrypted item. It must
 *   NEVER be marked dirty, mutated, or pushed to the sync server. If a stripped payload were
 *   encrypted and uploaded it would OVERWRITE the real ciphertext with a body-less version =
 *   irreversible data loss. The marker below lets every safety seam detect and refuse such a
 *   payload. Before any mutation, callers must re-hydrate full content via
 *   `getFullContent(uuid)` on the application.
 *
 * The marker lives directly on the decrypted content object under a reserved key. It is an
 * IN-MEMORY-ONLY concern: lite payloads are never persisted or ejected to disk/sync, so this
 * key never reaches storage or the server in normal operation. The strip/guard machinery is a
 * no-op unless the `lazyDecryptEnabled` application option is turned on.
 */

export const LiteContentMarkerKey = '__lazyLite' as const

/**
 * Content fields that are considered "bulky bodies" and are removed when producing a lite
 * projection. Currently only note `text`. Keep this list narrow and explicit.
 */
export const LiteStrippedContentFields: readonly string[] = ['text']

export interface LiteDecryptedContent extends ItemContent {
  [LiteContentMarkerKey]?: true
}

/**
 * Returns true if the given content object carries the lite marker.
 */
export function isLiteContent(content: unknown): boolean {
  return (
    typeof content === 'object' &&
    content !== null &&
    (content as Record<string, unknown>)[LiteContentMarkerKey] === true
  )
}

/**
 * Type guard: returns true if a payload is a content-stripped ("lite") decrypted payload.
 * This is the single predicate every safety seam uses to refuse lite payloads on the
 * dirty/mutation/sync paths.
 */
export function isLitePayload(payload: PayloadInterface | undefined | null): boolean {
  if (!payload) {
    return false
  }
  if (!isDecryptedPayload(payload)) {
    return false
  }
  return isLiteContent(payload.content)
}

/**
 * Produces a content-stripped copy of a decrypted transfer payload's content. Retains every
 * metadata field the UI needs and removes the bulky body field(s). Stamps the lite marker so
 * the result is detectable everywhere.
 */
export function stripContentToLiteProjection<C extends ItemContent = ItemContent>(content: C): C {
  const projection: Record<string, unknown> = { ...(content as unknown as Record<string, unknown>) }

  for (const field of LiteStrippedContentFields) {
    delete projection[field]
  }

  projection[LiteContentMarkerKey] = true

  return projection as unknown as C
}

/**
 * Given a fully-decrypted payload, returns an equivalent payload whose content body has been
 * stripped to the lite projection. The returned payload is intentionally NOT dirty. Used on the
 * cold-load path to discard bodies after metadata has been extracted.
 *
 * SAFETY: a lite payload is never dirty by construction; callers must never set dirty on it.
 */
export function createLitePayloadFromDecrypted<C extends ItemContent = ItemContent>(
  payload: DecryptedPayloadInterface<C>,
): DecryptedPayloadInterface<C> {
  const ejected: DecryptedTransferPayload<C> = payload.ejected()

  const liteContent = stripContentToLiteProjection(ejected.content)

  const liteTransfer: DecryptedTransferPayload<C> = {
    ...ejected,
    content: liteContent,
    /** A lite payload must never be dirty. */
    dirty: false,
    dirtyIndex: undefined,
  }

  return new DecryptedPayload<C>(liteTransfer, payload.source)
}
