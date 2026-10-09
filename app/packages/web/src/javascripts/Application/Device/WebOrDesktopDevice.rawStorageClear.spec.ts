/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: `WebOrDesktopDevice.removeAllRawStorageValues()` was a bare
 * `localStorage.clear()`, so a last-workspace sign-out erased EVERY other application's
 * localStorage on the origin — the twin of the `Database.deleteAll` defect fixed in
 * c9e67ec8, in a different storage area.
 *
 * Both directions are proven here, through the REAL call path
 * (`ApplicationGroup.onApplicationDeinit` -> `device.clearAllDataFromDevice(identifiers)`):
 *
 *   (1) the removed set is EXACTLY this application's own keys — every foreign key on the
 *       origin, including the operator's own `vogue-homes-crm`, survives untouched;
 *   (2) this application's own keys, and in particular every credential-bearing one, are
 *       genuinely GONE afterwards. A sign-out that leaves credentials behind is worse than
 *       the bug being fixed.
 *
 * WHAT THE FIXTURE REPRESENTS. Not an empty store: a real profile at the moment of a
 * last-workspace sign-out, as the production writers would have left it. It holds the device
 * keychain with real root-key material (WebDevice's 'keychain'), the per-workspace
 * `<identifier>-storage` blob carrying the session and the wrapped root key, the version and
 * storage-generation markers DiskStorageService/MigrationService write beside it, the
 * descriptor record ApplicationGroup boots from, a SECOND workspace under a generated uuid
 * and a THIRD under a hand-edited legacy identifier (so the caller's authoritative list is
 * exercised, not just the naming schemes), the local settings families, and snjs 1.x
 * leftovers that nothing has ever deleted. Seeding only settings keys would have let a
 * credential survive without any test noticing.
 */
import { namespacedKey, RawStorageKey } from '@standardnotes/snjs'

import { WebDevice } from './WebDevice'
import { ownStorageKeysIn } from './OwnedStorageKeys'

/** Names a real shared origin could be hosting next to this app. */
const FOREIGN_KEYS: Record<string, string> = {
  /** The operator's own separate application on this origin. */
  'vogue-homes-crm': '{"tenant":"vogue-homes"}',
  'vogue-homes-crm:auth': '{"refresh":"vh-refresh-token"}',
  firebaseLocalStorageDb: '{"user":"firebase-uid"}',
  'keyval-store': '{"idb-keyval":true}',
  'workbox-expiration': '{"cacheName":"other-app-precache"}',
  i18nextLng: 'pt-PT',
  'ally-supports-cache': '{"focus":true}',
  /**
   * NEAR MISSES. Each shares an opening with one of this app's namespaces but is not in it,
   * so they pin the boundary rather than decorate the fixture.
   */
  'snowflake-config': '{"warehouse":"x"}',
  standardnotesclone: '{"not":"ours"}',
  /** The same name Database.isOwnDatabaseName deliberately classifies as foreign. */
  'standardnotes-analytics': '{"visits":3}',
  'supercalendar:v1': '{"events":[]}',
  'assistantly-app': '{"session":"other"}',
  descriptorsOfSomethingElse: '[]',
  userSettings: '{"other":"app"}',
  /** A uuid-shaped key with a suffix this app does not use. */
  '018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5e-settings': '{"foreign":true}',
}

/** The legacy first workspace of every install (ApplicationGroup.createNewDescriptorRecord). */
const LEGACY_WORKSPACE = 'standardnotes'
/** A second workspace, named by the uuid createNewApplicationDescriptor generates. */
const UUID_WORKSPACE = '018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5e'
/** A third whose descriptor identifier is NOT uuid-shaped — only the caller's list finds it. */
const CUSTOM_WORKSPACE = 'a-legacy-custom-identifier'

/**
 * The keys that carry account material. Asserted gone individually, because "the removed set
 * equals the own set" would still pass if the own set itself were missing a credential.
 */
const CREDENTIAL_KEYS = [
  'keychain',
  namespacedKey(LEGACY_WORKSPACE, RawStorageKey.StorageObject),
  namespacedKey(UUID_WORKSPACE, RawStorageKey.StorageObject),
  namespacedKey(CUSTOM_WORKSPACE, RawStorageKey.StorageObject),
  'sn_trusted_device_token',
  'sn_shared_server_access_key',
  'standardnotes.github.publish.token.v1',
  'standard-red-notes:invite-realtime:v1:abc123',
  'user',
  'encryptedStorage',
  'auth_params',
]

/** Root-key material as RootKeyManager.saveRootKeyToKeychain persists it. */
const keychainBlob = JSON.stringify({
  [LEGACY_WORKSPACE]: { version: '004', masterKey: 'mk-legacy', dataAuthenticationKey: 'dak-legacy' },
  [UUID_WORKSPACE]: { version: '004', masterKey: 'mk-uuid', dataAuthenticationKey: 'dak-uuid' },
})

/** A `<identifier>-storage` blob as DiskStorageService writes it: session + wrapped root key. */
const storageObjectFor = (identifier: string) =>
  JSON.stringify({
    session: { accessToken: `at-${identifier}`, refreshToken: `rt-${identifier}` },
    user: { uuid: `user-${identifier}`, email: 'admin@vogue-homes.com' },
    WRAPPED_ROOT_KEY: { ciphertext: `wrapped-${identifier}` },
  })

const OWN_KEYS: Record<string, string> = {
  /** WebDevice's device keychain — root key material for every workspace on the origin. */
  keychain: keychainBlob,

  /** RawStorageKey.DescriptorRecord, as ApplicationGroup.persistDescriptors leaves it. */
  descriptors: JSON.stringify({
    [LEGACY_WORKSPACE]: { identifier: LEGACY_WORKSPACE, label: 'Main Workspace', primary: true },
    [UUID_WORKSPACE]: { identifier: UUID_WORKSPACE, label: 'Workspace 2', primary: false },
    [CUSTOM_WORKSPACE]: { identifier: CUSTOM_WORKSPACE, label: 'Workspace 3', primary: false },
  }),

  /** Per-workspace raw keys: every namespacedKey suffix snjs writes, for each workspace. */
  [namespacedKey(LEGACY_WORKSPACE, RawStorageKey.StorageObject)]: storageObjectFor(LEGACY_WORKSPACE),
  [namespacedKey(LEGACY_WORKSPACE, RawStorageKey.SnjsVersion)]: '2.200.0',
  [namespacedKey(LEGACY_WORKSPACE, 'storage_object_generation')]: '7',
  [namespacedKey(UUID_WORKSPACE, RawStorageKey.StorageObject)]: storageObjectFor(UUID_WORKSPACE),
  [namespacedKey(UUID_WORKSPACE, RawStorageKey.SnjsVersion)]: '2.200.0',
  [namespacedKey(UUID_WORKSPACE, 'storage_object_generation')]: '3',
  [namespacedKey(UUID_WORKSPACE, 'last_migration_timestamp')]: '1700000000',
  /** Only the caller's authoritative identifier list can classify these. */
  [namespacedKey(CUSTOM_WORKSPACE, RawStorageKey.StorageObject)]: storageObjectFor(CUSTOM_WORKSPACE),
  [namespacedKey(CUSTOM_WORKSPACE, RawStorageKey.SnjsVersion)]: '2.200.0',

  /** Desktop home-server configuration (RawStorageKey). */
  home_server_enabled: 'true',
  home_serve_data_location: '/home/mariana/.srn',

  /** The `sn-` / `sn_` families. */
  'sn-language': 'en',
  'sn-custom-themes': '[]',
  'sn-assistant-usage': '{"tokens":10}',
  'sn-auto-empty-trash-interval-ms:account-a': '86400000',
  sn_achievements_state: '{"unlocked":[]}',
  sn_trusted_device_token: 'trusted-device-jwt',
  sn_shared_server_access_key: 'shared-server-secret',
  sn_item_restore_counts: '{}',
  sn_super_show_formatting_marks: 'true',

  /** The `srn-` / `srn_` / `__srn_` families. */
  'srn-update-check-last-checked-at': '1760000000000',
  [`srn-storage-usage-snapshot-${UUID_WORKSPACE}`]: '{"bytes":1024}',
  srn_editor_tile_layout: '{"columns":2}',
  srn_folders_migrated_v1: '1',
  __srn_diagnostics_storage_probe__: 'probe',

  /** The `standardnotes.` local-settings namespace (note: a DOT, not a hyphen). */
  'standardnotes.sync-device-id.v1': 'device-id-1',
  'standardnotes.github.publish.token.v1': 'ghp_realtoken',
  'standardnotes.note.layout.v1': '{"mode":"wide"}',
  'standardnotes.notifications.read.v1': '["a"]',

  /** The invite-realtime checkpoint store. */
  'standard-red-notes:invite-realtime:v1:abc123': '{"cursor":"9"}',

  /** The assistant families, scoped and legacy-unscoped. */
  'assistant-chat-tabs': '[]',
  'assistant-context-scope': 'note',
  'assistant-workspace-registry:v1:account-a': '{}',
  'AssistantChatHistory:v1:account-a:tab-1': '[]',
  'AssistantChatTabs:v1:account-a': '[]',

  /** Super editor + diary. */
  'super-editor:recent-symbols': '["±"]',
  'DiaryMode.lastPromptedDate': '2026-10-08',

  /** ui-services' unprefixed keys. */
  AnonymousUserId: '"anon-1"',
  ShowBetaWarning: 'false',
  ShowNoAccountWarning: 'true',
  FilesNavigationEnabled: 'true',
  'master-persistence-key': '{"panes":[]}',
  keyboardShortcutOverrides: '{}',

  /** snjs 1.x leftovers that nothing has ever deleted. */
  user: '{"email":"admin@vogue-homes.com"}',
  encryptedStorage: '{"ciphertext":"legacy"}',
  auth_params: '{"pw_cost":5000}',
  offlineParams: '{"pw_salt":"legacy"}',
  syncToken: 'legacy-sync-token',
  migrations: '[]',
  last_migration_timestamp: '1500000000',
}

const seed = (entries: Record<string, string>) => {
  for (const [key, value] of Object.entries(entries)) {
    localStorage.setItem(key, value)
  }
}

const keysInStorage = (): string[] => {
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index++) {
    keys.push(localStorage.key(index) as string)
  }
  return keys.sort()
}

const originalIndexedDB = (window as any).indexedDB
const originalLockManager = navigator.locks

/**
 * Model only what jsdom lacks. `Database.deleteAll` needs a databases()/deleteDatabase()
 * pair, and the keychain mutation lock needs Web Locks; localStorage itself is jsdom's real
 * implementation, which is the point.
 */
const installDeviceEnvironment = () => {
  const deletedDatabases: string[] = []
  ;(window as any).indexedDB = {
    databases: jest.fn(async () => []),
    deleteDatabase: jest.fn((name: string) => {
      const request: any = { onerror: null, onsuccess: null, onblocked: null }
      Promise.resolve().then(() => {
        deletedDatabases.push(name)
        request.onsuccess && request.onsuccess({ target: request })
      })
      return request
    }),
    open: jest.fn(() => {
      throw new Error('no device-key database in this test')
    }),
  }
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: <T>(name: string, _options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> =>
        Promise.resolve(callback({ name, mode: 'exclusive' } as Lock)),
    },
  })
  return { deletedDatabases }
}

describe('removeAllRawStorageValues is scoped to this application', () => {
  beforeEach(() => {
    localStorage.clear()
    installDeviceEnvironment()
  })

  afterEach(() => {
    ;(window as any).indexedDB = originalIndexedDB
    Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLockManager })
    localStorage.clear()
  })

  /**
   * ApplicationGroup.onApplicationDeinit passes the identifiers of the workspaces being
   * destroyed. On DeinitSource.SignOutAll that is every descriptor; on the last-workspace
   * sign-out the descriptor was already removed and the list is EMPTY.
   */
  const signOutAll = async (workspaceIdentifiers: string[]) => {
    const device = new WebDevice('test-version')
    try {
      return await device.clearAllDataFromDevice(workspaceIdentifiers as any)
    } finally {
      device.deinit()
    }
  }

  it('removes exactly this application’s own keys and nothing else on the origin', async () => {
    seed(FOREIGN_KEYS)
    seed(OWN_KEYS)
    const before = keysInStorage()

    const result = await signOutAll([LEGACY_WORKSPACE, UUID_WORKSPACE, CUSTOM_WORKSPACE])

    expect(result).toEqual({ killsApplication: false })

    const after = keysInStorage()
    const removed = before.filter((key) => !after.includes(key))

    expect(removed).toEqual(Object.keys(OWN_KEYS).sort())
    expect(after).toEqual(Object.keys(FOREIGN_KEYS).sort())
  })

  it('leaves every foreign value byte-identical, not merely present', async () => {
    seed(FOREIGN_KEYS)
    seed(OWN_KEYS)

    await signOutAll([LEGACY_WORKSPACE, UUID_WORKSPACE, CUSTOM_WORKSPACE])

    for (const [key, value] of Object.entries(FOREIGN_KEYS)) {
      expect(localStorage.getItem(key)).toBe(value)
    }
  })

  it('leaves no credential of this application behind', async () => {
    seed(FOREIGN_KEYS)
    seed(OWN_KEYS)

    await signOutAll([LEGACY_WORKSPACE, UUID_WORKSPACE, CUSTOM_WORKSPACE])

    for (const key of CREDENTIAL_KEYS) {
      expect(localStorage.getItem(key)).toBeNull()
    }
    for (const key of Object.keys(OWN_KEYS)) {
      expect(localStorage.getItem(key)).toBeNull()
    }
  })

  /**
   * The case that actually ships. ApplicationGroup removes the last descriptor BEFORE
   * calling, so `identifiers` is empty and the naming-scheme sweep is the only thing that
   * can remove anything — including the legacy and uuid workspace blobs.
   */
  it('still clears every own key on a last-workspace sign-out, which passes an empty list', async () => {
    seed(FOREIGN_KEYS)
    seed(OWN_KEYS)

    await signOutAll([])

    expect(localStorage.getItem('keychain')).toBeNull()
    expect(localStorage.getItem(namespacedKey(LEGACY_WORKSPACE, RawStorageKey.StorageObject))).toBeNull()
    expect(localStorage.getItem(namespacedKey(UUID_WORKSPACE, RawStorageKey.StorageObject))).toBeNull()
    expect(localStorage.getItem('descriptors')).toBeNull()
    expect(localStorage.getItem('vogue-homes-crm')).toBe(FOREIGN_KEYS['vogue-homes-crm'])
  })

  /**
   * ...and the one key an empty list CANNOT reach: a workspace whose descriptor identifier is
   * not uuid-shaped. The caller's list is authoritative and additive, so SignOutAll takes it
   * while the naming-scheme sweep alone cannot.
   */
  it('needs the caller’s list for a workspace whose identifier is not uuid-shaped', async () => {
    seed(OWN_KEYS)

    await signOutAll([])

    expect(localStorage.getItem(namespacedKey(CUSTOM_WORKSPACE, RawStorageKey.StorageObject))).toBe(
      storageObjectFor(CUSTOM_WORKSPACE),
    )

    seed(OWN_KEYS)
    await signOutAll([CUSTOM_WORKSPACE])

    expect(localStorage.getItem(namespacedKey(CUSTOM_WORKSPACE, RawStorageKey.StorageObject))).toBeNull()
    expect(localStorage.getItem(namespacedKey(CUSTOM_WORKSPACE, RawStorageKey.SnjsVersion))).toBeNull()
  })

  it('does not invent keys: an identifier the caller passes that is not in storage is a no-op', () => {
    seed(FOREIGN_KEYS)

    expect(ownStorageKeysIn(localStorage, ['never-stored'])).toEqual([])
  })

  /**
   * The desktop "Clear Renderer Storage" path calls `window.device.removeAllRawStorageValues()`
   * with no arguments (Main/Window.ts), so the default must still be a full own-key sweep.
   */
  it('sweeps this application’s keys when called with no identifiers at all', async () => {
    seed(FOREIGN_KEYS)
    seed(OWN_KEYS)

    const device = new WebDevice('test-version')
    try {
      await device.removeAllRawStorageValues()
    } finally {
      device.deinit()
    }

    // Everything the naming schemes match is gone, foreign keys are untouched, and the only
    // survivors of ours are the ones no naming scheme can recognise: a workspace whose
    // descriptor identifier is neither the legacy name nor a uuid. Those need the caller's
    // authoritative list, which this entry point does not have.
    expect(keysInStorage()).toEqual(
      [
        ...Object.keys(FOREIGN_KEYS),
        namespacedKey(CUSTOM_WORKSPACE, RawStorageKey.StorageObject),
        namespacedKey(CUSTOM_WORKSPACE, RawStorageKey.SnjsVersion),
      ].sort(),
    )
  })
})
