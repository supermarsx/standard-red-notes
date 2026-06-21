import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'

// Standard Red Notes — Email reminders (server opt-in feature).
//
// Reminders the server may email to the account email when due. Unlike in-app
// reminders (E2E-encrypted in note appData), the time + message here are stored
// in PLAINTEXT because the user explicitly opted that reminder into email
// delivery. This e2e covers the CRUD surface over the real gateway HTTP API:
//   1. create -> 200 with a reminder id
//   2. list   -> the created reminder is present (plaintext time + message)
//   3. delete -> 200 and the reminder is gone
//   4. limit  -> creating beyond MAX_EMAIL_REMINDERS_PER_USER returns 400 with
//                the documented "reached the maximum" message
//
// Note: actual EMAIL DELIVERY (the TriggerDueEmailReminders cron) requires SMTP
// + the operator EMAIL_REMINDERS_ENABLED switch + a per-user opt-in, so that
// path is explicitly skipped below (needs SMTP). The CRUD API itself is always
// reachable and is what this spec asserts.

const base = (): string => SERVER.replace(/\/$/, '')

function accessTokenOf(app: any): string | undefined {
  const session = app.sessions.getSession?.()
  return session?.accessToken?.value ?? session?.accessToken
}

async function createReminder(
  token: string,
  dueAt: number,
  message: string,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base()}/v1/email-reminders/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ dueAt, message }),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function listReminders(token: string): Promise<any[]> {
  const res = await fetch(`${base()}/v1/email-reminders/`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = (await res.json().catch(() => ({}))) as any
  return (body?.data ?? body)?.emailReminders ?? []
}

function reminderIdOf(create: { data: any }): string | undefined {
  const d = create.data?.data ?? create.data
  return d?.emailReminder?.uuid ?? d?.emailReminder?.id
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const { app, dataDir } = await freshAccount()
  const token = accessTokenOf(app.app)
  check('account has a session access token', Boolean(token))
  if (!token) {
    await cleanup(app, dataDir)
    finish()
    return
  }

  const due = Date.now() + 60 * 60 * 1000
  const message = `e2e reminder ${Date.now()}`

  // 1. Create.
  const created = await createReminder(token, due, message)
  const reminderId = reminderIdOf(created)

  // Gate: if the gateway has no email-reminders route (older build / feature not
  // deployed), it answers 404 with an HTML "Cannot POST" page. Skip cleanly.
  if (created.status === 404) {
    console.log(
      'SKIP: POST /v1/email-reminders is not routed on this server (the email-reminders ' +
        'feature is not present in this deployment). Nothing to assert.',
    )
    await cleanup(app, dataDir)
    process.exit(0)
  }

  check('POST /v1/email-reminders creates a reminder (200 + id)', created.status === 200 && Boolean(reminderId))

  // 2. List shows it (plaintext message + due time round-tripped).
  const list = await listReminders(token)
  const found = list.find((r: any) => (r.uuid ?? r.id) === reminderId)
  check('GET /v1/email-reminders lists the created reminder', Boolean(found))
  check(
    'the listed reminder round-trips its plaintext message',
    Boolean(found) && String(found.message) === message,
  )

  // 3. Delete it.
  if (reminderId) {
    const delRes = await fetch(`${base()}/v1/email-reminders/${reminderId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    check('DELETE /v1/email-reminders removes the reminder (200)', delRes.status === 200)

    const after = await listReminders(token)
    check(
      'the deleted reminder is gone from the list',
      !after.some((r: any) => (r.uuid ?? r.id) === reminderId),
    )
  }

  // 4. Limit: keep creating until the server rejects with the documented 400.
  //    MAX_EMAIL_REMINDERS_PER_USER defaults to 100; a value <= 0 means unlimited.
  //    Cap the attempts so an "unlimited" instance ends the loop cleanly and the
  //    limit assertion is skipped with a clear message rather than looping forever.
  const MAX_ATTEMPTS = 130
  let limitStatus = 0
  let limitMessage = ''
  let createdCount = 0
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const r = await createReminder(token, due, `limit-probe-${i}`)
    if (r.status === 200) {
      createdCount++
      continue
    }
    limitStatus = r.status
    limitMessage = String(r.data?.error?.message ?? r.data?.data?.error?.message ?? '')
    break
  }

  if (limitStatus === 0) {
    console.log(
      `SKIP (limit assertion): created ${createdCount} reminders without hitting a cap — ` +
        'MAX_EMAIL_REMINDERS_PER_USER appears to be unlimited (<= 0) on this instance.',
    )
  } else {
    check(
      'creating beyond MAX_EMAIL_REMINDERS_PER_USER returns 400 with the documented message',
      limitStatus === 400 && /reached the maximum/i.test(limitMessage),
    )
  }

  // Email DELIVERY (the reminder cron) is NOT exercised: it needs SMTP + the
  // operator EMAIL_REMINDERS_ENABLED switch + a per-user opt-in. The "no-records"
  // delete-on-send behaviour likewise requires a real send. Both are out of scope
  // for a CRUD-only e2e and would otherwise be faked.
  console.log(
    'SKIP: email delivery + EMAIL_REMINDER_NO_RECORDS behaviour (needs SMTP, the ' +
      'EMAIL_REMINDERS_ENABLED operator switch, and a per-user opt-in).',
  )

  await cleanup(app, dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
