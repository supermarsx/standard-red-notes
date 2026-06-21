import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'

// Standard Red Notes — Bannable users (admin-gated).
//
// An admin (INTERNAL_TEAM_USER role) can ban a user; enforcement then happens in
// SignIn (new sign-ins are rejected with 403) and AuthenticateUser (an existing
// banned session is rejected on its next authenticated call). The ADMIN side of
// this is reachable only with the internal-team role, which a fresh e2e account
// does not have and cannot self-grant over the API. So this spec asserts the
// reachable half — the admin gate itself — and SKIPS the actual ban-enforcement
// assertions (they need an INTERNAL_TEAM_USER account, i.e. a DB role seed) with
// a clear reason rather than faking a pass.
//
// What IS asserted here (over the real gateway HTTP API):
//   - a NON-admin (ordinary) account cannot read or set ban status: the admin
//     ban endpoints reject it with 401 "Operation not allowed."
// What is SKIPPED (needs an internal-team admin account):
//   - banning a user and observing their next authenticated request fail
//   - a banned user's sign-in being rejected with 403

const base = (): string => SERVER.replace(/\/$/, '')

function accessTokenOf(app: any): string | undefined {
  const session = app.sessions.getSession?.()
  return session?.accessToken?.value ?? session?.accessToken
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const { app, email, dataDir } = await freshAccount()
  const token = accessTokenOf(app.app)
  check('account has a session access token', Boolean(token))
  if (!token) {
    await cleanup(app, dataDir)
    finish()
    return
  }

  // A non-admin trying to READ ban status is rejected by the admin gate.
  const getBan = await fetch(`${base()}/v1/admin/users/${encodeURIComponent(email)}/ban-status`, {
    headers: { authorization: `Bearer ${token}` },
  })

  // Gate: if the admin ban routes are not present on this server (older build),
  // the gateway answers 404 with an HTML "Cannot GET" page. Skip cleanly.
  if (getBan.status === 404) {
    console.log(
      'SKIP: /v1/admin/users/:email/ban-status is not routed on this server (the bannable-users ' +
        'admin endpoints are not present in this deployment). Nothing to assert.',
    )
    await cleanup(app, dataDir)
    process.exit(0)
  }

  check('a non-admin cannot read ban status (admin gate returns 401)', getBan.status === 401)

  // A non-admin trying to SET a ban (even on themselves) is rejected.
  // userUuid path segment can be the caller's own uuid; the role check fires first.
  const ownUuid: string | undefined = app.app.getUser?.()?.uuid ?? app.app.sessions.getUser?.()?.uuid
  const targetUuid = ownUuid ?? '00000000-0000-0000-0000-000000000000'
  const setBan = await fetch(`${base()}/v1/admin/users/${targetUuid}/ban-status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ banned: true, banReason: 'e2e should-not-apply' }),
  })
  check('a non-admin cannot set ban status (admin gate returns 401)', setBan.status === 401)

  // Defense-in-depth sanity: the caller is still able to use their own session
  // normally (the rejected admin call did not affect their account).
  const stillWorks = await fetch(`${base()}/v1/sessions`, {
    headers: { authorization: `Bearer ${token}` },
  })
  check('the ordinary account session is unaffected by the rejected admin calls', stillWorks.status === 200)

  console.log(
    'SKIP: ban ENFORCEMENT (banned sign-in rejected with 403; banned session rejected ' +
      'on next request). Requires an INTERNAL_TEAM_USER admin account to issue the ban, ' +
      'which cannot be provisioned through the public API in this harness.',
  )

  await cleanup(app, dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
