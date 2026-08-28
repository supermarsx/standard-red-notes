import { ApiVersion } from './ApiVersion'

/**
 * Versions that share the modern (20200115) sync response family. Durable sync
 * commands must resolve to this family so their stored/replayed response
 * contract is stable.
 *
 * This lives BESIDE ApiVersion.ts rather than inside it because ApiVersion.ts
 * and SyncResponseFactoryResolver.ts are pinned byte-identical to the upstream
 * Standard Notes server (docs/_data/standard_notes_compatibility.json,
 * upstream.server.exactLocalFiles). Fork-only helpers go in fork-only files so
 * the upstream interoperability surface stays provably unmodified.
 *
 * The version list is therefore stated twice — here and in the upstream
 * resolver's switch. ModernSyncResponse.spec.ts asserts the two agree for every
 * declared API version, so the duplication cannot drift silently.
 */
export function usesModernSyncResponse(apiVersion?: string): boolean {
  return (
    apiVersion === ApiVersion.v20190520 || apiVersion === ApiVersion.v20200115 || apiVersion === ApiVersion.v20240226
  )
}
