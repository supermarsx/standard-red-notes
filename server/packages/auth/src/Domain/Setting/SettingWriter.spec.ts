import { readFileSync } from 'fs'
import { join } from 'path'
import { SettingName } from '@standardnotes/domain-core'

import { ADMIN_MANAGEABLE_SETTINGS } from '../../Infra/InversifyExpressUtils/Base/BaseAdminController'
import { isWritableByItsOwner, settingsWrittenBy, writerOfSetting } from './SettingWriter'

const EVERY_SETTING = Object.values(SettingName.NAMES)

/**
 * Settings an administrator sets through an endpoint of their own rather than
 * through the per-user flags endpoint, so they are gates without being in its
 * allow-list. Each is refused or special-cased there by name.
 */
const SET_THROUGH_THEIR_OWN_ADMIN_ENDPOINT = [
  // PUT /v1/admin/registration, instance-wide.
  SettingName.NAMES.RegistrationDisabled,
  // A subscription setting: the flags endpoint routes it to its own write path
  // before it consults the allow-list.
  SettingName.NAMES.FileUploadBytesLimit,
]

/** The settings `CreateCrossServiceToken` reads, taken from its own source. */
const settingsMintedIntoTheToken = (): string[] => {
  const source = readFileSync(
    join(__dirname, '..', 'UseCase', 'CreateCrossServiceToken', 'CreateCrossServiceToken.ts'),
    'utf8',
  )
  const keys = [...source.matchAll(/SettingName\.NAMES\.([A-Za-z]+)/g)].map((match) => match[1])

  return [...new Set(keys)].map((key) => SettingName.NAMES[key as keyof typeof SettingName.NAMES])
}

/**
 * Standard Red Notes: the declaration of who may write each setting, held
 * against the places a gate actually takes effect.
 *
 * Three administrator gates (WORKFLOWS_ENABLED, OCR_SERVER_ALLOWED,
 * NEXTCLOUD_BACKUP_ALLOWED) were writable by the accounts they gate, because the
 * only thing that made a setting administrator-only was remembering to add it
 * to a list of exceptions. Nothing below is a list of gates. Every expectation
 * is derived: from `SettingName.NAMES`, from the admin panel's own allow-list,
 * from the source of the token minting, and from the settings' own names.
 */
describe('who may write each setting', () => {
  it('is declared for every setting the server knows', () => {
    expect(EVERY_SETTING.length).toBeGreaterThan(40)

    expect(EVERY_SETTING.filter((name) => writerOfSetting(name) === undefined)).toEqual([])
  })

  it('refuses the owner a setting nobody declared', () => {
    expect(writerOfSetting('SOMETHING_ADDED_TOMORROW')).toBeUndefined()
    expect(isWritableByItsOwner('SOMETHING_ADDED_TOMORROW')).toBe(false)
  })

  it('lets the owner write only what was declared as the owner’s', () => {
    for (const name of EVERY_SETTING) {
      const writer = writerOfSetting(name)

      expect([name, isWritableByItsOwner(name)]).toEqual([
        name,
        writer === 'owner' || writer === 'owner-or-administrator',
      ])
    }
  })

  /**
   * Both directions, so neither list can move without the other. Adding a name
   * to the admin panel's allow-list is the step every one of the three gates DID
   * take; it now fails here until the setting is also declared as something an
   * administrator may set. And a gate declared here that the panel cannot set is
   * a gate nobody can grant.
   */
  it('agrees with the admin panel’s allow-list, name for name', () => {
    const settableByAnAdministrator = settingsWrittenBy('administrator', 'owner-or-administrator').filter(
      (name) => !SET_THROUGH_THEIR_OWN_ADMIN_ENDPOINT.includes(name),
    )

    expect([...ADMIN_MANAGEABLE_SETTINGS].sort()).toEqual(settableByAnAdministrator.sort())
    // The exceptions are real gates, not a way round the comparison above.
    expect(SET_THROUGH_THEIR_OWN_ADMIN_ENDPOINT.map((name) => writerOfSetting(name))).toEqual([
      'administrator',
      'administrator',
    ])
  })

  /**
   * A setting an administrator can set, whose value is then minted into the
   * token every other service authorizes against, is a grant. If its owner
   * could write it too, the owner would be minting their own grant. (An opt-in
   * the administrator cannot set, such as CALDAV_ENABLED, is the owner's and is
   * not caught here: there is nobody else's decision for it to override.)
   */
  it('gives the owner no setting that an administrator sets and the token carries', () => {
    const minted = settingsMintedIntoTheToken()
    // The source really was read: these have been minted since the gates existed.
    expect(minted).toEqual(
      expect.arrayContaining([
        SettingName.NAMES.AiEnabled,
        SettingName.NAMES.CollaborationEnabled,
        SettingName.NAMES.LiveSyncEnabled,
      ]),
    )

    const grants = minted.filter((name) => ADMIN_MANAGEABLE_SETTINGS.includes(name))
    expect(grants.length).toBeGreaterThanOrEqual(8)
    expect(grants.filter((name) => isWritableByItsOwner(name))).toEqual([])
  })

  it('gives the owner no setting whose own name says somebody else allows it', () => {
    const allowed = EVERY_SETTING.filter((name) => name.endsWith('_ALLOWED'))
    expect(allowed.length).toBeGreaterThanOrEqual(3)

    expect(allowed.filter((name) => writerOfSetting(name) !== 'administrator')).toEqual([])
  })

  /**
   * The floor under the table. Everything that was refused to its owner while
   * that was decided by a list of exceptions is still refused now that it is
   * decided here. The gates above are derived; the server's own bookkeeping has
   * no second source to be derived from, so it is pinned.
   */
  it('still refuses the owner everything that was refused before this table existed', () => {
    const refusedBefore = [
      SettingName.NAMES.AiEnabled,
      SettingName.NAMES.AiRequestLimit,
      SettingName.NAMES.AiFiveHourTokenLimit,
      SettingName.NAMES.AiWeeklyTokenLimit,
      SettingName.NAMES.CollaborationEnabled,
      SettingName.NAMES.LiveSyncEnabled,
      SettingName.NAMES.DavBridgeAllowed,
      SettingName.NAMES.ListedAuthorSecrets,
      SettingName.NAMES.FileUploadBytesLimit,
      SettingName.NAMES.FileUploadBytesUsed,
      SettingName.NAMES.EmailBackupLastSent,
      SettingName.NAMES.EmailBackupDeliveryState,
      SettingName.NAMES.NextcloudBackupLastRun,
      SettingName.NAMES.NextcloudBackupDeliveryState,
      SettingName.NAMES.RegistrationDisabled,
    ]

    expect(refusedBefore.filter((name) => isWritableByItsOwner(name))).toEqual([])
  })

  it('keeps what the server writes for itself away from both', () => {
    const serverOwned = settingsWrittenBy('server')
    expect(serverOwned.length).toBeGreaterThanOrEqual(6)

    expect(serverOwned.filter((name) => isWritableByItsOwner(name))).toEqual([])
    expect(serverOwned.filter((name) => ADMIN_MANAGEABLE_SETTINGS.includes(name))).toEqual([])
  })
})
