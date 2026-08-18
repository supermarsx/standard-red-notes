export enum ApiVersion {
  v20161215 = '20161215',
  v20190520 = '20190520',
  v20200115 = '20200115',
  v20240226 = '20240226',
}

/**
 * Versions that share the modern sync response family. Durable commands must
 * resolve to this family so their stored/replayed response contract is stable.
 */
export function usesModernSyncResponse(apiVersion?: string): boolean {
  return (
    apiVersion === ApiVersion.v20190520 || apiVersion === ApiVersion.v20200115 || apiVersion === ApiVersion.v20240226
  )
}
