/**
 * Standard Red Notes: client-side storage for the server-wide shared access key.
 *
 * SECURITY MODEL: this key is an OBFUSCATION / access-gating secret provided by
 * the self-hosted server operator. It lets the official client pass an optional
 * gateway gate that makes the instance refuse requests from clients that do not
 * present it. It is NOT your account password and NOT end-to-end security — real
 * confidentiality of note content is still the existing client-side E2E
 * encryption. The key is per-device operator configuration, so it is persisted
 * in localStorage (NOT as a synced item) and attached as a header on outgoing
 * requests by FetchRequestHandler.
 */

export const SHARED_SERVER_ACCESS_KEY_HEADER = 'X-Shared-Server-Key'

const STORAGE_KEY = 'sn_shared_server_access_key'

export const readSharedServerAccessKey = (): string | undefined => {
  try {
    if (typeof localStorage === 'undefined') {
      return undefined
    }
    return localStorage.getItem(STORAGE_KEY) ?? undefined
  } catch {
    // localStorage may be unavailable (non-browser runtime or private mode). In
    // that case no key is attached, which is the correct fail-open default for a
    // server that does not have the gate enabled.
    return undefined
  }
}

export const persistSharedServerAccessKey = (key: string): void => {
  try {
    localStorage.setItem(STORAGE_KEY, key)
  } catch {
    // No-op: the device simply won't present the key, matching the unset state.
  }
}

export const clearSharedServerAccessKey = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // No-op.
  }
}
