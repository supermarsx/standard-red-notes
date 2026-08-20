import { ContentType } from '@standardnotes/domain-core'
import { isObject, isString } from '@standardnotes/utils'
import { DecryptedTransferPayload } from './DecryptedTransferPayload'
import { DeletedTransferPayload } from './DeletedTransferPayload'
import { EncryptedTransferPayload } from './EncryptedTransferPayload'
import { TransferPayload } from './TransferPayload'

export type FullyFormedTransferPayload = DecryptedTransferPayload | EncryptedTransferPayload | DeletedTransferPayload

export function isDecryptedTransferPayload(payload: TransferPayload): payload is DecryptedTransferPayload {
  return isObject(payload.content)
}

export function isEncryptedTransferPayload(payload: TransferPayload): payload is EncryptedTransferPayload {
  return 'content' in payload && isString(payload.content)
}

export function isErrorDecryptingTransferPayload(payload: TransferPayload): payload is EncryptedTransferPayload {
  return isEncryptedTransferPayload(payload) && payload.errorDecrypting === true
}

export function isDeletedTransferPayload(payload: TransferPayload): payload is DeletedTransferPayload {
  return 'deleted' in payload && payload.deleted === true
}

/**
 * Content types this client creates and syncs that the pinned, published
 * `@standardnotes/domain-core` build does not enumerate — see FolderContentType, which documents
 * why the client cannot extend `ContentType.TYPES`.
 *
 * Without this, `ContentType.create('Folder')` fails and every folder arriving from the server is
 * classified as a corrupt record and dropped before it can be applied. The folder then never
 * exists in local item state, which makes creation re-insert it (duplicate folders) and makes its
 * uuid mismatch on every integrity check forever. Delete this list once domain-core ships the type.
 */
const LOCALLY_DEFINED_CONTENT_TYPES: ReadonlySet<string> = new Set(['Folder'])

function isKnownContentType(contentType: string): boolean {
  return !ContentType.create(contentType).isFailed() || LOCALLY_DEFINED_CONTENT_TYPES.has(contentType)
}

export function isCorruptTransferPayload(payload: TransferPayload): boolean {
  const invalidDeletedState = payload.deleted === true && payload.content != undefined

  return payload.uuid == undefined || invalidDeletedState || !isKnownContentType(payload.content_type)
}
