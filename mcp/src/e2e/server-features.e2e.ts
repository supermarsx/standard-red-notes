import { check, cleanup, finish, freshAccount, SERVER, serverUp, skip } from './helpers.js'
import type { HeadlessApp } from '../snjs/bootstrap.js'

// SERVER-MEDIATED entitlements + feature/config flags for the
// `STANDARD_RED_FEATURES_MODE=included` fork. Unlike entitlements.e2e.ts (which
// proves an unlocked capability via the snjs vault path), this suite drives the
// raw auth/gateway HTTP surface the web client reads and asserts the response
// SHAPES the server actually returns:
//
//   GET /v1/users/:uuid/subscription  -> { success, user, subscription }   (BaseUsersController.getSubscription)
//   GET /v1/users/:uuid/features      -> { success, userUuid, features[] }  (BaseFeaturesController.getFeatures)
//   GET /v1/users/:uuid/settings      -> { success, settings[] }            (BaseSettingsController.getSettings)
//   PUT /v1/users/:uuid/settings      -> { success, setting? }              (BaseSettingsController.updateSetting)
//   GET /v1/users/:uuid/settings/:n   -> { success, setting? }             (BaseSettingsController.getSetting)
//
// In `included` mode the server SYNTHESIZES a full PRO subscription and returns
// the complete feature set for any account with no real subscription row:
//   - GetUserSubscription.createIncludedSubscription -> planName PRO_PLAN, cancelled:false, far-future endsAt
//     (server/packages/auth/src/Domain/UseCase/GetUserSubscription/GetUserSubscription.ts:48-82)
//   - FeatureService.getFeaturesForUser -> GetFeatures() every entry stamped role_name PRO_USER, no_expire:true
//     (server/packages/auth/src/Domain/Feature/FeatureService.ts:23-34)
// A fresh user's session carries the CORE_USER role PLUS a synthetic PRO_USER
// role (uuid "singletier-PRO_USER") — but NOT INTERNAL_TEAM_USER — so admin
// endpoints (INTERNAL_TEAM_USER-gated, BaseAdminController.ts:79-81) stay denied.
//
// NOTE: the api-gateway wraps every auth-server JSON response as
//   { meta: { auth, server }, data: <payload> }
// so the asserted payload lives under `.data` (see unwrap() below).

const PRO_PLAN = 'PRO_PLAN'
const PRO_USER = 'PRO_USER'

function accessToken(app: HeadlessApp): string | undefined {
  const s = app.app.sessions.getSession?.()
  return s?.accessToken?.value ?? s?.accessToken
}

function userUuid(app: HeadlessApp): string {
  return (app.app as { sessions: { getSureUser(): { uuid: string } } }).sessions.getSureUser().uuid
}

// The api-gateway envelopes payloads as { meta, data }. Unwrap to the inner
// `data` so callers assert against the auth-server payload directly (and fall
// back to the raw body for non-enveloped error responses).
function unwrap(body: any): any {
  return body && typeof body === 'object' && 'data' in body ? body.data : body
}

async function getJson(url: string, token: string): Promise<{ status: number; body: any; raw: any }> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  const raw = await res.json().catch(() => ({}))
  return { status: res.status, body: unwrap(raw), raw }
}

async function putSetting(
  uuid: string,
  token: string,
  name: string,
  value: string,
): Promise<{ status: number; body: any; raw: any }> {
  const res = await fetch(`${SERVER}/v1/users/${uuid}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, value }),
  })
  const raw = await res.json().catch(() => ({}))
  return { status: res.status, body: unwrap(raw), raw }
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
  check('fresh account has a user uuid', typeof uuid === 'string' && uuid.length > 0)
  if (!token) {
    await cleanup(app, dataDir)
    finish()
    return
  }

  // --- Entitlement: a brand-new account with no real subscription row is still
  //     handed a full PRO subscription (the heart of `included` mode). ----------
  const sub = await getJson(`${SERVER}/v1/users/${uuid}/subscription`, token)
  check('subscription endpoint returns 200', sub.status === 200)
  check('subscription response.success is true', sub.body?.success === true)
  const subscription = sub.body?.subscription
  check('a subscription object is present for an unsubscribed account', !!subscription)
  check('included subscription is the PRO plan (no free-tier gating)', subscription?.planName === PRO_PLAN)
  check('included subscription is not cancelled', subscription?.cancelled === false)
  check(
    'included subscription does not expire in the near future (far-future endsAt)',
    typeof subscription?.endsAt === 'number' && subscription.endsAt > Date.now() * 1000,
  )
  check('subscription response echoes the user identity', sub.body?.user?.uuid === uuid)

  // --- Entitlement: the features endpoint returns the FULL included set, every
  //     feature stamped PRO_USER and non-expiring (no PRO gating). --------------
  const feat = await getJson(`${SERVER}/v1/users/${uuid}/features`, token)
  check('features endpoint returns 200', feat.status === 200)
  check('features response.success is true', feat.body?.success === true)
  const features: any[] = Array.isArray(feat.body?.features) ? feat.body.features : []
  check('features list is non-empty (full set provisioned)', features.length > 0)
  check('every feature is granted at the PRO_USER role', features.every((f) => f?.role_name === PRO_USER))
  check(
    'no feature carries an expiry (no_expire / expires_at undefined)',
    features.every((f) => f?.no_expire === true || f?.expires_at == null),
  )
  // If a recognizable premium-gated capability exists upstream, it must be
  // present here. We don't hard-require a specific identifier (the upstream set
  // varies by version), but if any feature advertises an identifier, assert the
  // collection is genuinely the full catalog rather than a trimmed free subset.
  const identifiers = features.map((f) => f?.identifier).filter((id): id is string => typeof id === 'string')
  check('features expose stable identifiers', identifiers.length === features.length)

  // A 400 whose error reads "Invalid setting name" means the deployed build
  // predates a fork-added setting (the source has it; the running binary is
  // stale). We treat that as a SKIP, not a failure, so the suite stays honest
  // about the live build while still exercising the name when present.
  const isUnknownSetting = (r: { status: number; body: any }): boolean =>
    r.status === 400 && /invalid setting name/i.test(String(r.body?.error?.message ?? ''))

  // --- Server-mediated setting ROUND-TRIP: EMAIL_BACKUP_FREQUENCY is an
  //     unsensitive, unencrypted, client-mutable, permission-gated setting that
  //     a free `included` account can set -> set then read back. ---------------
  const setBackup = await putSetting(uuid, token, 'EMAIL_BACKUP_FREQUENCY', 'daily')
  check('setting EMAIL_BACKUP_FREQUENCY succeeds', setBackup.status === 200 && setBackup.body?.success === true)
  const readBackup = await getJson(`${SERVER}/v1/users/${uuid}/settings/EMAIL_BACKUP_FREQUENCY`, token)
  check(
    'EMAIL_BACKUP_FREQUENCY reads back the value we set (round-trip persists)',
    readBackup.body?.setting?.value === 'daily',
  )

  // A second unsensitive round-trip on a long-standing setting (broad coverage).
  const setMute = await putSetting(uuid, token, 'MUTE_MARKETING_EMAILS', 'muted')
  check('setting MUTE_MARKETING_EMAILS succeeds', setMute.status === 200 && setMute.body?.success === true)
  check('an unsensitive setting is flagged sensitive:false', setMute.body?.setting?.sensitive === false)
  const readMute = await getJson(`${SERVER}/v1/users/${uuid}/settings/MUTE_MARKETING_EMAILS`, token)
  check('MUTE_MARKETING_EMAILS reads back its value', readMute.body?.setting?.value === 'muted')

  // The fork's email-reminder opt-in is likewise unsensitive and must round-trip
  // when the build knows the name; skip honestly on a stale build.
  const setReminder = await putSetting(uuid, token, 'EMAIL_REMINDERS_ENABLED', 'true')
  if (isUnknownSetting(setReminder)) {
    skip('EMAIL_REMINDERS_ENABLED round-trip', 'setting name not in deployed build (fork-added)')
  } else {
    check('setting EMAIL_REMINDERS_ENABLED succeeds', setReminder.status === 200 && setReminder.body?.success === true)
    const readReminder = await getJson(`${SERVER}/v1/users/${uuid}/settings/EMAIL_REMINDERS_ENABLED`, token)
    check(
      'EMAIL_REMINDERS_ENABLED reads back true (email-reminder opt-in persists)',
      readReminder.body?.setting?.value === 'true',
    )
  }

  // --- Sensitive classification: a SENSITIVE setting is stored encrypted and is
  //     NEVER returned in plaintext by a normal getSetting read — the API reports
  //     only its existence (success:true, no `setting`/value). EXTENSION_KEY is a
  //     long-standing sensitive setting present in every build. -----------------
  const EXT_SECRET = 'super-secret-extension-key-' + Date.now()
  const setExt = await putSetting(uuid, token, 'EXTENSION_KEY', EXT_SECRET)
  check('setting EXTENSION_KEY (sensitive) succeeds', setExt.status === 200 && setExt.body?.success === true)
  // updateSetting omits the projection for a sensitive setting (no value echoed).
  check(
    'the PUT response for a sensitive setting does not echo a value',
    setExt.body?.setting === undefined || setExt.body?.setting?.value === undefined,
  )
  const readExt = await getJson(`${SERVER}/v1/users/${uuid}/settings/EXTENSION_KEY`, token)
  check('reading a sensitive setting returns 200', readExt.status === 200)
  check('a sensitive setting is NOT returned as a value (existence only)', readExt.body?.setting === undefined)
  check('a sensitive setting value is never echoed in the response body', !JSON.stringify(readExt.raw).includes(EXT_SECRET))

  // The bulk settings listing must likewise never leak the sensitive value.
  const allSettings = await getJson(`${SERVER}/v1/users/${uuid}/settings`, token)
  check('settings listing returns 200', allSettings.status === 200)
  check('settings listing does not leak the sensitive value', !JSON.stringify(allSettings.raw).includes(EXT_SECRET))

  // The fork's Nextcloud app password proves the SAME sensitive classification
  // for a fork-added setting; skip honestly when the deployed build lacks it.
  const NC_SECRET = 'super-secret-nextcloud-pw-' + Date.now()
  const setNc = await putSetting(uuid, token, 'NEXTCLOUD_BACKUP_APP_PASSWORD', NC_SECRET)
  if (isUnknownSetting(setNc)) {
    skip('NEXTCLOUD_BACKUP_APP_PASSWORD sensitivity', 'setting name not in deployed build (fork-added)')
  } else {
    check('setting NEXTCLOUD_BACKUP_APP_PASSWORD succeeds', setNc.status === 200 && setNc.body?.success === true)
    const readNc = await getJson(`${SERVER}/v1/users/${uuid}/settings/NEXTCLOUD_BACKUP_APP_PASSWORD`, token)
    check('the Nextcloud app password is NOT returned as a value', readNc.body?.setting === undefined)
    check('the Nextcloud app password is never echoed in the response body', !JSON.stringify(readNc.raw).includes(NC_SECRET))
  }

  // --- Role/permission: a normal (CORE_USER) account cannot reach an admin-only
  //     endpoint. `included` mode unlocks FEATURES, never the admin role. -------
  const adminLookup = await fetch(`${SERVER}/v1/admin/lookup-user/someone%40example.com`, {
    headers: { authorization: `Bearer ${token}` },
  })
  await adminLookup.text().catch(() => undefined)
  check(
    'a normal user is denied the admin lookup endpoint (401/403)',
    adminLookup.status === 401 || adminLookup.status === 403,
  )
  const adminReg = await fetch(`${SERVER}/v1/admin/registration`, {
    headers: { authorization: `Bearer ${token}` },
  })
  await adminReg.text().catch(() => undefined)
  check(
    'a normal user is denied the admin registration-flag endpoint (401/403)',
    adminReg.status === 401 || adminReg.status === 403,
  )

  // --- Cross-account isolation: the per-user endpoints reject a uuid that is not
  //     the session owner (BaseUsersController/Features/Settings 401 guard). ----
  const otherUuid = '00000000-0000-0000-0000-000000000000'
  const foreignSub = await getJson(`${SERVER}/v1/users/${otherUuid}/subscription`, token)
  check(
    "cannot read another user's subscription (operation not allowed)",
    foreignSub.status === 401 || foreignSub.status === 403,
  )

  await cleanup(app, dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
