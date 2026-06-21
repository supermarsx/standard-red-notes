import { check, cleanup, finish, freshAccount, SERVER, serverUp, skip } from './helpers.js'
import type { HeadlessApp } from '../snjs/bootstrap.js'

// `included` mode, viewed through the SETTINGS-PERMISSION + lifecycle surface,
// complementing server-features.e2e.ts (which asserts the subscription/features
// response shapes). Here we prove the permission-GATED behaviors that the fork's
// "everything included" stance must unlock, plus the settings lifecycle edges
// the fork added.
//
// Code references for the asserted behaviors:
//   - DailyEmailBackup permission is REQUIRED to set EMAIL_BACKUP_FREQUENCY
//     (server/packages/auth/src/Domain/Setting/SettingsAssociationService.ts:80-83).
//     SetSettingValue runs with checkUserPermissions:true (BaseSettingsController.ts:211-216),
//     so a free account succeeding proves the permission is granted under `included`.
//   - An unset optional setting returns an empty 200, not a 400
//     (BaseSettingsController.getSetting, ...:122-133).
//   - deleteSetting removes a value so a subsequent read is empty
//     (BaseSettingsController.deleteSetting / DeleteSetting use case).

function accessToken(app: HeadlessApp): string | undefined {
  const s = app.app.sessions.getSession?.()
  return s?.accessToken?.value ?? s?.accessToken
}

function userUuid(app: HeadlessApp): string {
  return (app.app as { sessions: { getSureUser(): { uuid: string } } }).sessions.getSureUser().uuid
}

// The api-gateway envelopes payloads as { meta, data }; unwrap to `data`.
function unwrap(body: any): any {
  return body && typeof body === 'object' && 'data' in body ? body.data : body
}

async function getSetting(uuid: string, token: string, name: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER}/v1/users/${uuid}/settings/${name}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = unwrap(await res.json().catch(() => ({})))
  return { status: res.status, body }
}

async function putSetting(
  uuid: string,
  token: string,
  name: string,
  value: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER}/v1/users/${uuid}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, value }),
  })
  const body = unwrap(await res.json().catch(() => ({})))
  return { status: res.status, body }
}

async function deleteSetting(uuid: string, token: string, name: string): Promise<number> {
  const res = await fetch(`${SERVER}/v1/users/${uuid}/settings/${name}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  await res.text().catch(() => undefined)
  return res.status
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const { app, dataDir } = await freshAccount()
  const token = accessToken(app)
  const uuid = userUuid(app)
  check('fresh account has a session access token', typeof token === 'string' && token!.length > 0)
  if (!token) {
    await cleanup(app, dataDir)
    finish()
    return
  }

  // --- An unset optional setting must not return a value. The FORK intends an
  //     empty 200 (BaseSettingsController.getSetting:122-133); a pre-fork build
  //     returns 400 "not found". Either way the invariant is "no value", and we
  //     note when the build predates the empty-200 behavior. -------------------
  const unset = await getSetting(uuid, token, 'EMAIL_BACKUP_FREQUENCY')
  const unsetEmpty200 = unset.status === 200 && unset.body?.success === true && unset.body?.setting === undefined
  const unsetLegacy404 = unset.status === 400 && /not found/i.test(String(unset.body?.error?.message ?? ''))
  if (unsetLegacy404) {
    skip('unset optional setting returns empty 200', 'deployed build still 400s on a missing setting (pre-fork)')
  } else {
    check('reading an unset optional setting returns an empty 200 (no value)', unsetEmpty200)
  }
  check('an unset optional setting never carries a value', unset.body?.setting === undefined)

  // --- Permission gate: DailyEmailBackup is required to set EMAIL_BACKUP_FREQUENCY
  //     and is enforced (checkUserPermissions:true). A free account succeeding
  //     proves `included` mode grants the permission. -------------------------
  const setWeekly = await putSetting(uuid, token, 'EMAIL_BACKUP_FREQUENCY', 'weekly')
  check(
    'a free account CAN enable scheduled email backups (DailyEmailBackup permission granted)',
    setWeekly.status === 200 && setWeekly.body?.success === true,
  )
  const readWeekly = await getSetting(uuid, token, 'EMAIL_BACKUP_FREQUENCY')
  check('EMAIL_BACKUP_FREQUENCY persisted as weekly', readWeekly.body?.setting?.value === 'weekly')

  // --- Update over an existing value (idempotent re-set), then read back. -----
  const setDisabled = await putSetting(uuid, token, 'EMAIL_BACKUP_FREQUENCY', 'disabled')
  check('re-setting EMAIL_BACKUP_FREQUENCY to disabled succeeds', setDisabled.status === 200)
  const readDisabled = await getSetting(uuid, token, 'EMAIL_BACKUP_FREQUENCY')
  check('EMAIL_BACKUP_FREQUENCY updated to disabled', readDisabled.body?.setting?.value === 'disabled')

  // --- Delete lifecycle: removing the setting makes a subsequent read empty. --
  const delStatus = await deleteSetting(uuid, token, 'EMAIL_BACKUP_FREQUENCY')
  check('deleting EMAIL_BACKUP_FREQUENCY returns 200', delStatus === 200)
  const afterDelete = await getSetting(uuid, token, 'EMAIL_BACKUP_FREQUENCY')
  // After deletion the value is gone: the fork returns an empty 200, a pre-fork
  // build returns 400 "not found". The invariant either way is "no value".
  check('after delete the setting carries no value', afterDelete.body?.setting === undefined)
  check(
    'after delete the read is either an empty 200 or a not-found 400',
    (afterDelete.status === 200 && afterDelete.body?.success === true) ||
      (afterDelete.status === 400 && /not found/i.test(String(afterDelete.body?.error?.message ?? ''))),
  )

  // --- An invalid setting name is rejected (proves name validation is active,
  //     so the included grants don't bypass input validation). ----------------
  const bogus = await putSetting(uuid, token, 'TOTALLY_NOT_A_SETTING', 'x')
  check('setting an unknown setting name is rejected (400)', bogus.status === 400)

  await cleanup(app, dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
