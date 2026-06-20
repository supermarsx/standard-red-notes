import { FullyFormedPayloadInterface } from '../../Abstract/Payload/Interfaces/UnionTypes'
import { isDecryptedPayload } from '../../Abstract/Payload/Interfaces/TypeCheck'
import { AppDataField } from '../../Abstract/Item/Types/AppDataField'
import { DefaultAppDomain } from '../../Abstract/Item/Types/DefaultAppDomain'

/**
 * Returns true when a payload is flagged "local only" (excluded from sync). The flag lives
 * in the decrypted appData under the default app domain. Only decrypted payloads can be
 * evaluated; encrypted/deleted payloads are treated as not-local-only (they should follow
 * the normal sync path).
 *
 * Pure and dependency-free so it can be reused by the sync upload filter and the integrity
 * payload filter, and unit-tested in isolation.
 */
export function PayloadIsLocalOnly(payload: FullyFormedPayloadInterface): boolean {
  if (!isDecryptedPayload(payload)) {
    return false
  }

  const appDomainData = payload.content.appData?.[DefaultAppDomain]

  return appDomainData?.[AppDataField.LocalOnly] === true
}
