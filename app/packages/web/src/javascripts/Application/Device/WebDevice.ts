import { Environment, RawKeychainValue } from '@standardnotes/snjs'
import { WebOrDesktopDevice } from './WebOrDesktopDevice'
import { CrossTabCoordinator } from '../CrossTab/CrossTabCoordinator'
import {
  decryptKeychain,
  deleteDeviceKey,
  encryptKeychain,
  getOrCreateDeviceKey,
  isEnvelope,
  isWrappingAvailable,
} from './KeychainEncryption'

const KEYCHAIN_STORAGE_KEY = 'keychain'
const DESTROYED_DEVICE_URL_PARAM = 'destroyed'
const DESTROYED_DEVICE_URL_VALUE = 'true'

/**
 * STAGED-ROLLOUT FEATURE FLAG — SHIPPED DEFAULT OFF.
 *
 * When OFF (the shipped state): setKeychainValue writes the keychain to localStorage as
 * plaintext JSON EXACTLY as before (status-quo, zero behavior change) and no lazy migration
 * runs. When ON: setKeychainValue and the first read of a legacy plaintext keychain wrap it
 * under the device-bound, non-exportable WebCrypto key (see KeychainEncryption.ts).
 *
 * The READ / UNWRAP path is ALWAYS compiled in regardless of this flag: any blob that is
 * already a wrapped envelope must always be unwrappable, or wrapped users would be bricked.
 * For that reason the unwrap path must be treated as PERMANENT once shipped, and turning this
 * flag back OFF is a safe rollback (already-wrapped users keep decrypting).
 *
 * Flipping this ON is a deliberate STAGED-ROLLOUT decision that REQUIRES the account-password
 * keychain-repair path (BaseMigration.repairMissingKeychain) to be verified end-to-end first:
 * wrapping introduces exactly ONE new lockout risk — if IndexedDB is cleared while the
 * localStorage 'keychain' is retained, the envelope can no longer be decrypted, and recovery
 * relies on re-entering the account password. See .orchestration/plans/t15.md (RISKS #1).
 */
const KEYCHAIN_AT_REST_WRAPPING_ENABLED = false

/**
 * Cross-tab namespace for KEYCHAIN coordination. The keychain is a SINGLE global
 * localStorage blob shared by every workspace on this origin, so its coordination
 * channel is global (not per-identifier).
 */
const KEYCHAIN_CROSSTAB_NAMESPACE = 'keychain'

export class WebDevice extends WebOrDesktopDevice {
  environment = Environment.Web

  /**
   * Standard Red Notes (multi-tab keychain safety): coordinates keychain changes across
   * tabs. When ANOTHER tab clears/rotates the keychain (logout / password change), this
   * tab is locked the instant the change is observed (window 'storage' event AND a
   * BroadcastChannel keychain message) so it can never encrypt/save under a stale key.
   * Lazily created on first keychain access so a never-authed share viewer pays nothing.
   */
  private crossTabCoordinator?: CrossTabCoordinator

  /**
   * SECURITY NOTE (PERSIST-H1): on web the keychain (which holds the account/root key
   * material) is persisted in localStorage. When the user has NO passcode set, that root
   * key — and therefore the session/user data it protects — sit at rest and, unless wrapped,
   * are readable by anyone with local access to the origin's storage (another script on the
   * same origin, disk forensics, a shared machine). With a passcode, the root key is wrapped
   * before reaching this layer, so the at-rest exposure window is the no-passcode case.
   *
   * KEYCHAIN-AT-REST WRAPPING (shipped, flag-gated — see KEYCHAIN_AT_REST_WRAPPING_ENABLED):
   *  - When the flag is ON, the keychain blob is wrapped under a device-bound, NON-EXPORTABLE
   *    AES-GCM CryptoKey held in its own tiny IndexedDB DB (extractable=false, so the raw bits
   *    never leave the browser). setKeychainValue writes the envelope; the first read of a
   *    legacy plaintext keychain lazily migrates it. Both durably persist the device key BEFORE
   *    the atomic localStorage.setItem, so storage always holds old-plaintext-or-new-envelope.
   *  - The UNWRAP path is ALWAYS active (flag-independent). If the envelope cannot be decrypted
   *    (IndexedDB cleared => key lost, or GCM auth failure) getKeychainValue returns {} rather
   *    than throwing, which routes into the existing BaseMigration.repairMissingKeychain
   *    account-password recovery — never a silent drop, never a partial read, never a reset.
   *  - The SHIPPED DEFAULT is OFF (plaintext, status-quo). Enabling it is a staged-rollout
   *    decision gated on verifying that repair path end-to-end (RISKS #1 in the plan).
   *
   * Mitigations verified to be in place (no silent loss / leftover key material):
   *  - Sign-out: UserService.signOut -> EncryptionService.deleteWorkspaceSpecificKeyStateFromDevice
   *    -> device.clearNamespacedKeychainValue(identifier), which removes that workspace's
   *    entry from the keychain blob and re-persists it.
   *  - Full reset / remove-all: WebOrDesktopDevice.clearAllDataFromDevice calls
   *    clearRawKeychainValue() (removes the whole 'keychain' key AND deletes the device key)
   *    then removeAllRawStorageValues() (localStorage.clear()), so nothing is left behind.
   *    NOTE: clearAllDataFromDevice lives in WebOrDesktopDevice (a peer-owned file); the
   *    device-key deletion there currently relies on clearRawKeychainValue() below calling
   *    deleteDeviceKey(). See the t15-e2 summary follow-up.
   */
  /**
   * Standard Red Notes: the cross-tab coordinator that guards the keychain. Created
   * lazily on first access so it is shared by getKeychainValue/setKeychainValue and is
   * reachable from the bootstrap wiring and from the per-database save coordination.
   */
  public getCrossTabCoordinator(): CrossTabCoordinator {
    if (!this.crossTabCoordinator) {
      this.crossTabCoordinator = new CrossTabCoordinator({
        namespace: KEYCHAIN_CROSSTAB_NAMESPACE,
        callbacks: {
          onKeychainInvalidated: () => this.handleForeignKeychainChange(),
        },
      })
    }
    return this.crossTabCoordinator
  }

  /**
   * True once another tab has cleared/rotated the keychain. Once true it stays true
   * until reload, and any further write/encryption MUST be refused.
   */
  public isKeychainLocked(): boolean {
    return this.crossTabCoordinator?.isLocked() ?? false
  }

  /**
   * Foreign keychain change handler. Entering this state is IRREVERSIBLE until reload:
   * the session changed in another tab, so anything we encrypt/save now would be under a
   * stale key. We force a soft reload, which re-reads the keychain fresh from storage and
   * either re-locks (passcode) or re-derives state. Reload is the safest universal action;
   * a host that wants a softer UX can surface a "session changed in another tab" screen,
   * but the lock itself (isKeychainLocked) is what actually blocks the unsafe writes.
   */
  private handleForeignKeychainChange(): void {
    try {
      // Best-effort: stop scheduling further work before the reload lands.
      // The lock flag (checked by setKeychainValue and Database.savePayloads) is already
      // set by the coordinator before this callback runs, so writes are blocked NOW.
      window.location.reload()
    } catch (error) {
      console.error('[WebDevice] Failed to reload after foreign keychain change', error)
    }
  }

  /**
   * Whether migrate-on-write / wrap-on-write is enabled. Isolated behind a method (reading the
   * module constant) so the SHIPPED default stays OFF while tests can exercise the flag-ON path
   * by overriding it. The read/unwrap path is deliberately NOT gated by this.
   */
  protected isWrappingEnabled(): boolean {
    return KEYCHAIN_AT_REST_WRAPPING_ENABLED
  }

  async getKeychainValue(): Promise<RawKeychainValue> {
    // Ensure the coordinator (and its storage listener) is installed before we ever rely
    // on keychain material, so a foreign clear/rotate can't slip past unobserved.
    this.getCrossTabCoordinator()

    // Re-read from storage on every access (do NOT trust a once-read in-memory copy): if a
    // foreign tab cleared/rotated the keychain we must not encrypt under a stale value.
    const value = localStorage.getItem(KEYCHAIN_STORAGE_KEY)

    if (!value) {
      return {}
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      // Genuinely corrupt (non-JSON) storage: route into the account-password repair path
      // rather than throwing. Legacy plaintext and envelopes are both valid JSON, so this only
      // fires on true corruption. NEVER throw from the keychain read.
      console.warn('[WebDevice] Keychain storage is not valid JSON; returning empty for repair.', error)
      return {}
    }

    // UNWRAP PATH — ALWAYS active (flag-independent): an already-wrapped envelope must always
    // be decryptable, even if the migrate-on-write flag is OFF.
    if (isEnvelope(parsed)) {
      try {
        const key = await getOrCreateDeviceKey()
        const decrypted = await decryptKeychain(parsed, key)
        return JSON.parse(decrypted)
      } catch (error) {
        // Key missing (IndexedDB cleared) OR GCM auth failure (tamper / wrong key). Return {}
        // so the existing BaseMigration.repairMissingKeychain account-password recovery flow
        // catches it. NEVER throw, NEVER return partial, NEVER hard-reset.
        console.warn(
          '[WebDevice] Could not decrypt wrapped keychain; returning empty for account-password repair.',
          error,
        )
        return {}
      }
    }

    // Legacy plaintext RawKeychainValue.
    const plaintext = parsed as RawKeychainValue

    // Lazy one-time migration to wrapped-at-rest, gated by the staged-rollout flag. Best-effort:
    // any failure (or unavailable crypto/IndexedDB) leaves the plaintext intact (status-quo).
    if (this.isWrappingEnabled()) {
      try {
        if (await isWrappingAvailable()) {
          // getOrCreateDeviceKey awaits IndexedDB tx.oncomplete (durable) BEFORE the atomic
          // localStorage.setItem, so storage holds old-plaintext-or-new-envelope, never garbage.
          const key = await getOrCreateDeviceKey()
          const envelope = await encryptKeychain(JSON.stringify(plaintext), key)
          localStorage.setItem(KEYCHAIN_STORAGE_KEY, JSON.stringify(envelope))
        }
      } catch (error) {
        console.warn('[WebDevice] Lazy keychain wrapping migration failed; leaving plaintext intact.', error)
      }
    }

    return plaintext
  }

  async setKeychainValue(value: RawKeychainValue): Promise<void> {
    // Refuse to persist a keychain once another tab has changed it: the in-memory key this
    // value was derived from is stale, and writing it would clobber the foreign rotation.
    if (this.isKeychainLocked()) {
      throw new Error('Keychain changed in another tab; refusing to write under a stale key (reloading).')
    }

    let stored = false
    if (this.isWrappingEnabled()) {
      try {
        if (await isWrappingAvailable()) {
          // CRITICAL ORDER: getOrCreateDeviceKey awaits device-key durability (IndexedDB
          // tx.oncomplete) BEFORE the atomic, synchronous localStorage.setItem below — so
          // storage always holds the old-or-new value, never garbage.
          const key = await getOrCreateDeviceKey()
          const envelope = await encryptKeychain(JSON.stringify(value), key)
          localStorage.setItem(KEYCHAIN_STORAGE_KEY, JSON.stringify(envelope))
          stored = true
        }
      } catch (error) {
        // Wrapping failed unexpectedly: fall back to the status-quo plaintext write so the
        // keychain write itself never fails (losing the write would be worse than not wrapping).
        console.warn('[WebDevice] Keychain wrapping on write failed; falling back to plaintext.', error)
      }
    }

    if (!stored) {
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, JSON.stringify(value))
    }

    // Notify peers so they lock immediately (the window 'storage' event also fires in other
    // tabs, but the BroadcastChannel message is faster and works when storage events are
    // throttled/coalesced).
    this.getCrossTabCoordinator().emitKeychainChanged()
  }

  async clearRawKeychainValue(): Promise<void> {
    localStorage.removeItem(KEYCHAIN_STORAGE_KEY)

    // Logout / full reset: tell peers the session is gone so they lock and reload before
    // they can autosave under the now-removed key.
    this.getCrossTabCoordinator().emitKeychainChanged()

    // Leave no device key behind after a full clear of the keychain. deleteDeviceKey never
    // throws (missing/unavailable IndexedDB is swallowed).
    await deleteDeviceKey()
  }

  override deinit(): void {
    this.crossTabCoordinator?.deinit()
    this.crossTabCoordinator = undefined
    super.deinit()
  }

  async performHardReset(): Promise<void> {
    const url = new URL(window.location.href)
    const params = url.searchParams
    params.append(DESTROYED_DEVICE_URL_PARAM, DESTROYED_DEVICE_URL_VALUE)
    window.location.replace(url.href)
  }

  public isDeviceDestroyed(): boolean {
    const url = new URL(window.location.href)
    const params = url.searchParams
    return params.get(DESTROYED_DEVICE_URL_PARAM) === DESTROYED_DEVICE_URL_VALUE
  }
}
