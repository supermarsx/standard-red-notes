/** UI-independent storage signals shared with the Electron renderer. */
export const LOCAL_STORAGE_HEALTH_EVENT = 'srn-local-storage-health'
export type LocalStorageHealthEventDetail = {
  code: 'quota-exceeded' | 'database-unavailable' | 'write-ok'
  source: 'items'
}

export function reportLocalStorageHealth(
  code: LocalStorageHealthEventDetail['code'],
  source: LocalStorageHealthEventDetail['source'],
): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<LocalStorageHealthEventDetail>(LOCAL_STORAGE_HEALTH_EVENT, { detail: { code, source } }),
    )
  }
}
