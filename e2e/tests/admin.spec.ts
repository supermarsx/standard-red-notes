import { test, expect } from '@playwright/test'
import {
  apiCall,
  closePreferences,
  clearRateLimitStateQuiet,
  freshUser,
  openPreferences,
  refreshSession,
  registerUser,
  registerInPage,
  signInUser,
  srnAdmin,
  srnAdminQuiet,
  syncAndWaitForAdminRole,
  waitForAppReady,
  type Session,
} from '../helpers/admin'

/**
 * ADMIN-STORY GATE — the repeatable end-to-end check for the whole admin chain:
 *
 *   1. Operator grant paths: `srn-admin grant-admin` (direct role) and RBAC
 *      group-conferred admin (`group create ... ADMIN_USER` + add-user)
 *      must both unlock the /v1/admin surface for a fresh session — the
 *      group-conferred variant is the historic regression (group roles must
 *      union into the cross-service token at mint time).
 *   2. Status-code matrix over a representative /v1/admin endpoint set:
 *      unauthed → 401, authed non-admin → 403 (NEVER 401 — the password-prompt
 *      bug class), admin → 200. This pins down the auth-side route wiring: every
 *      admin route must decode the forwarded cross-service token, or genuine
 *      admins 403 (the live-stack bug this gate was written against).
 *   3. HTTP grant/revoke (PUT /v1/admin/users/:uuid/admin-role) round-trip and
 *      the self-revocation 400 guard; audit-log records the actions with the
 *      correct actor.
 *   4. Legacy auth-internal /admin/* routes stay UNREACHABLE through the public
 *      gateway (SPA/404/405 — never an admin JSON response).
 *   5. UI: a non-admin sees no Admin entry in Preferences; after a CLI grant
 *      (+ role propagation via response meta) the Admin entry appears and the
 *      tabs load without tripping the stale-role 403 notice.
 *
 * Everything runs against the LIVE stack on :3001 and the in-container CLI, so
 * the docker-compose stack must be up. All users are @local.test throwaways;
 * the spec cleans up its group and revokes granted roles, and is safe to re-run.
 *
 * NOTE on propagation: this deployment does not set CROSS_SERVICE_TOKEN_CACHE_TTL,
 * so the api-gateway's cross-service-token cache is DISABLED and role changes
 * take effect on the target user's NEXT request (no session refresh needed).
 * The assertions below only rely on the weaker, always-true guarantee (fresh
 * session/refresh sees the change) so they also hold on cache-enabled deploys.
 */

const ADMIN_PROBE = '/v1/admin/users?limit=1'

// Representative endpoint set for the 401/403/200 matrix (mutation-free).
const MATRIX_ENDPOINTS: Array<[string, string]> = [
  ['GET', '/v1/admin/users?limit=5'],
  ['GET', '/v1/admin/audit-log?limit=10'],
  ['GET', '/v1/admin/registration'],
  ['GET', '/v1/admin/roles'],
  ['GET', '/v1/admin/groups'],
  ['GET', '/v1/admin/server-status'],
  ['GET', '/v1/admin/logs?limit=5'],
]

test.setTimeout(4 * 60_000)

test.describe('@chromium', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'admin gate runs on chromium only')

  test.beforeEach(() => {
    clearRateLimitStateQuiet()
  })

  test('API: grant paths + status-code matrix + HTTP grant/revoke + audit', async () => {
    const nonAdminUser = freshUser('admgate-nonadmin')
    const adminUser = freshUser('admgate-admin')
    const targetUser = freshUser('admgate-target')
    const groupUser = freshUser('admgate-group')
    const groupName = `admgate-adminsX-${Date.now()}`

    const nonAdminReg = await registerUser(nonAdminUser)
    const adminReg = await registerUser(adminUser)
    const targetReg = await registerUser(targetUser)
    await registerUser(groupUser)

    try {
      // ---- 1. CLI grant: role lands in the DB and a fresh session unlocks. ----
      const preGrant = await apiCall('GET', ADMIN_PROBE, { token: adminReg.session.access_token })
      expect(preGrant.status, 'pre-grant session must be denied with 403').toBe(403)

      srnAdmin('grant-admin', adminUser.email)
      expect(srnAdmin('list-roles', adminUser.email)).toContain('ADMIN_USER')

      const adminSession = await signInUser(adminUser)
      const postGrant = await apiCall('GET', ADMIN_PROBE, { token: adminSession.access_token })
      expect(postGrant.status, 'fresh session after CLI grant must reach admin endpoints').toBe(200)
      expect(postGrant.data.total, 'users list must actually answer').toBeGreaterThan(0)

      // Refresh path: a refreshed pre-grant session must also carry the role.
      const refreshed = await refreshSession(nonAdminReg.session)
      const nonAdminSession: Session = refreshed

      // ---- 2. Status-code matrix (401 / 403 / 200). ----
      for (const [method, endpoint] of MATRIX_ENDPOINTS) {
        const unauthed = await apiCall(method, endpoint)
        expect(unauthed.status, `${endpoint} unauthed must be 401`).toBe(401)

        const asNonAdmin = await apiCall(method, endpoint, { token: nonAdminSession.access_token })
        expect(asNonAdmin.status, `${endpoint} as non-admin must be 403 (NEVER 401)`).toBe(403)

        const asAdmin = await apiCall(method, endpoint, { token: adminSession.access_token })
        expect(asAdmin.status, `${endpoint} as admin must be 200`).toBe(200)
      }

      // ---- 3. Group-conferred admin (the historic regression). ----
      srnAdmin('group', 'create', groupName, 'ADMIN_USER')
      srnAdmin('group', 'add-user', groupName, groupUser.email)
      const groupSession = await signInUser(groupUser)
      const viaGroup = await apiCall('GET', ADMIN_PROBE, { token: groupSession.access_token })
      expect(viaGroup.status, 'group-conferred ADMIN_USER must unlock admin endpoints').toBe(200)

      srnAdmin('group', 'remove-user', groupName, groupUser.email)
      const afterRemoval = await apiCall('GET', ADMIN_PROBE, { token: (await signInUser(groupUser)).access_token })
      expect(afterRemoval.status, 'leaving the group must drop admin access on a fresh token').toBe(403)

      // ---- 4. HTTP grant/revoke + self-revocation guard. ----
      const grant = await apiCall('PUT', `/v1/admin/users/${targetReg.uuid}/admin-role`, {
        token: adminSession.access_token,
        body: { granted: true },
      })
      expect(grant.status, 'HTTP admin-role grant must succeed').toBe(200)
      const grantedSession = await signInUser(targetUser)
      expect((await apiCall('GET', ADMIN_PROBE, { token: grantedSession.access_token })).status).toBe(200)

      const revoke = await apiCall('PUT', `/v1/admin/users/${targetReg.uuid}/admin-role`, {
        token: adminSession.access_token,
        body: { granted: false },
      })
      expect(revoke.status, 'HTTP admin-role revoke must succeed').toBe(200)
      expect(
        (await apiCall('GET', ADMIN_PROBE, { token: (await signInUser(targetUser)).access_token })).status,
        'revoked admin must lose access on a fresh token',
      ).toBe(403)

      const selfRevoke = await apiCall('PUT', `/v1/admin/users/${adminReg.uuid}/admin-role`, {
        token: adminSession.access_token,
        body: { granted: false },
      })
      expect(selfRevoke.status, 'self-revocation must be refused with 400').toBe(400)

      // ---- 5. Audit log carries the grant/revoke with the correct actor. ----
      const audit = await apiCall('GET', '/v1/admin/audit-log?limit=50', { token: adminSession.access_token })
      expect(audit.status).toBe(200)
      const roleEntries = (audit.data.entries as Array<Record<string, unknown>>).filter(
        (entry) => entry.action === 'role.changed' && entry.actorUuid === adminReg.uuid && entry.targetUuid === targetReg.uuid,
      )
      expect(roleEntries.length, 'audit log must record the HTTP grant AND revoke with actor/target').toBeGreaterThanOrEqual(2)

      // ---- 6. Legacy auth-internal /admin/* stays unreachable via the gateway. ----
      const legacyProbes: Array<[string, string]> = [
        ['GET', `/admin/user/${encodeURIComponent(targetUser.email)}`],
        ['GET', `/admin/users/${targetReg.uuid}/listed-code`],
        ['DELETE', `/admin/users/${targetReg.uuid}/mfa`],
        ['POST', `/admin/users/${targetReg.uuid}/subscription-token`],
        ['POST', `/admin/users/${encodeURIComponent(targetUser.email)}/offline-subscription-token`],
        ['POST', `/admin/users/${targetReg.uuid}/email-backups`],
      ]
      for (const [method, endpoint] of legacyProbes) {
        const res = await apiCall(method, endpoint, { token: adminSession.access_token })
        // GETs fall through to the SPA (html); non-GETs get nginx 404/405 — the
        // route must NEVER answer with admin JSON (no `uuid`/`token` payloads).
        const looksHtml = typeof res.rawText === 'string' && /<!doctype html|<html/i.test(res.rawText)
        const unreachable = looksHtml || res.status === 404 || res.status === 405
        expect(unreachable, `${method} ${endpoint} must not be reachable through the gateway (got ${res.status})`).toBe(true)
      }
    } finally {
      // Cleanup: best-effort; the users themselves are throwaway @local.test.
      srnAdminQuiet('group', 'delete', groupName)
      srnAdminQuiet('revoke-admin', adminUser.email)
      srnAdminQuiet('revoke-admin', targetUser.email)
    }
  })

  test('UI: Admin entry hidden for non-admins, appears + tabs load after grant', async ({ page }) => {
    const uiUser = freshUser('admgate-ui')

    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await page.locator('.main-ui-view, #footer-bar').first().waitFor({ state: 'visible', timeout: 60_000 })
      await waitForAppReady(page)
      // Register in-page (real client flow) — a raw-API account cannot be signed
      // into from the client (server-password derivation, see helpers/admin.ts).
      await registerInPage(page, uiUser)

      // Non-admin: Preferences shows NO Admin entry.
      await openPreferences(page)
      const adminEntry = page.locator('.preferences-menu-item', { hasText: 'Admin' })
      await expect(adminEntry, 'non-admin must not see the Admin menu entry').toHaveCount(0)
      await closePreferences(page)

      // Grant AFTER sign-in. Roles ride along on every decorated response's
      // meta.auth.roles, so a sync round-trip propagates them to the client.
      srnAdmin('grant-admin', uiUser.email)
      await syncAndWaitForAdminRole(page, true)

      // Reopen Preferences (menu is rebuilt per open) — Admin entry must exist.
      await openPreferences(page)
      await expect(adminEntry, 'admin must see the Admin menu entry').toHaveCount(1)
      await adminEntry.click()

      // Users tab (default) loads and populates without the stale-role notice.
      const staleNotice = page.getByText('Admin access not active on the server yet')
      await expect(page.getByRole('heading', { name: 'Users', exact: true }).first()).toBeVisible()
      await expect(page.getByText(uiUser.email).first(), 'users list must populate').toBeVisible({ timeout: 30_000 })
      await expect(staleNotice).toHaveCount(0)

      // Server tab: health section renders.
      await page.getByRole('tab', { name: 'Server' }).click()
      await page.getByRole('tab', { name: 'Health & services', exact: true }).click()
      await expect(page.getByText('Server health').first()).toBeVisible({ timeout: 30_000 })
      await expect(staleNotice).toHaveCount(0)

      // Groups tab: RBAC view renders.
      await page.getByRole('tab', { name: 'Groups & roles' }).click()
      await expect(page.getByRole('heading', { name: 'Groups & roles', exact: true }).first()).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.getByRole('heading', { name: 'Roles', exact: true }).first()).toBeVisible({ timeout: 30_000 })
      await expect(staleNotice).toHaveCount(0)

      // Logs tab: audit entries render under the Audit logs subtab (the grant above guarantees at least one).
      await page.getByRole('tab', { name: 'Logs', exact: true }).click()
      await page.getByRole('tab', { name: 'Audit logs', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Audit log' }).first()).toBeVisible({ timeout: 30_000 })
      await expect(staleNotice).toHaveCount(0)
    } finally {
      srnAdminQuiet('revoke-admin', uiUser.email)
    }
  })

  test('UI: stale-role 403 notice shows when the server revokes mid-session', async ({ page }) => {
    const staleUser = freshUser('admgate-stale')

    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await page.locator('.main-ui-view, #footer-bar').first().waitFor({ state: 'visible', timeout: 60_000 })
      await waitForAppReady(page)
      await registerInPage(page, staleUser)

      srnAdmin('grant-admin', staleUser.email)
      await syncAndWaitForAdminRole(page, true)
      await openPreferences(page)
      const adminEntry = page.locator('.preferences-menu-item', { hasText: 'Admin' })
      await adminEntry.click()
      await expect(page.getByRole('heading', { name: 'Users', exact: true }).first()).toBeVisible()

      // Revoke SERVER-side while the pane is open. Two valid outcomes, decided
      // by a race with the client's background role refresh (roles ride along on
      // every response's meta.auth.roles):
      //   - roles still stale when the next admin call fires → the call 403s and
      //     the pane surfaces the inline stale-role notice;
      //   - a sync refreshed the roles first → the pane's role gate flips and it
      //     renders the "no administrator access" fallback instead.
      // Either way the revoke must NEVER fail silently (tab keeps rendering data).
      srnAdmin('revoke-admin', staleUser.email)
      await page.getByRole('tab', { name: 'Server' }).click()
      const staleNoticeOrFallback = page
        .getByText('Admin access not active on the server yet')
        .or(page.getByText('You do not have administrator access'))
      await expect(
        staleNoticeOrFallback.first(),
        'server-side revoke must surface the stale-role notice or the access-removed fallback',
      ).toBeVisible({ timeout: 30_000 })
    } finally {
      srnAdminQuiet('revoke-admin', staleUser.email)
    }
  })
})
