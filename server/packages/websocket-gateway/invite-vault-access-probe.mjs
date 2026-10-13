/**
 * Proves (or disproves) that ACCEPTING a shared-vault invite grants real access:
 * the owner writes an item into the vault, and the invited member can read it
 * ONLY after accepting. The control is the read BEFORE acceptance -- without it
 * "the member can read the item" would prove nothing about the invite.
 */
import { WebSocket } from 'ws'
import { randomBytes, randomUUID } from 'node:crypto'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3870'
const TOPOLOGY = process.env.TOPOLOGY ?? 'unknown'
const API = '20200115'
void WebSocket

async function raw(method, path, { body, token, cookie } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const envelope = parsed && typeof parsed === 'object' && 'data' in parsed && 'meta' in parsed
  return { status: r.status, json: envelope ? parsed.data : parsed, text, setCookie: r.headers.getSetCookie?.() ?? [] }
}
const cookieHeaderFrom = (s) =>
  s.map((e) => e.split(';', 1)[0].trim()).filter((p) => p.includes('=') && !p.endsWith('=')).join('; ')

async function register(label) {
  const email = `invite-access-${label}-${Date.now()}-${randomBytes(2).toString('hex')}@example.com`
  const r = await raw('POST', '/v1/users', {
    body: {
      email,
      password: randomBytes(32).toString('hex'),
      api: '20240226',
      version: '004',
      pw_nonce: randomBytes(32).toString('hex'),
      origination: 'registration',
      created: String(Date.now()),
      ephemeral: false,
    },
  })
  if (r.status !== 200) throw new Error(`register ${label}: ${r.status} ${r.text.slice(0, 200)}`)
  return { email, uuid: r.json.user.uuid, token: r.json.session.access_token, cookie: cookieHeaderFrom(r.setCookie) }
}

const sync = (cred, body) =>
  raw('POST', '/v1/items', {
    token: cred.token,
    cookie: cred.cookie,
    body: { api: API, sync_token: null, limit: 150, compute_integrity: false, ...body },
  })

function item(extra = {}) {
  const iso = new Date().toISOString()
  return {
    uuid: randomUUID(),
    content_type: 'Note',
    content: '004:' + randomBytes(128).toString('base64'),
    enc_item_key: '004:' + randomBytes(72).toString('base64'),
    items_key_id: null,
    created_at: iso,
    updated_at: iso,
    created_at_timestamp: Date.now() * 1000,
    updated_at_timestamp: Date.now() * 1000,
    deleted: false,
    auth_hash: null,
    duplicate_of: null,
    ...extra,
  }
}

function say(name, verdict, evidence) {
  console.log(`  [${verdict}] ${name} ${evidence === undefined ? '' : JSON.stringify(evidence)}`)
}

async function main() {
  console.log(`\n=== VAULT ACCESS AFTER ACCEPTANCE - topology=${TOPOLOGY} base=${BASE} ===`)
  const owner = await register('owner')
  const member = await register('member')

  const vault = await raw('POST', '/v1/shared-vaults', { token: owner.token, cookie: owner.cookie, body: {} })
  const vaultUuid = vault.json?.sharedVault?.uuid
  say('the owner created a shared vault (setup)', vaultUuid ? 'ctrl' : 'NO  ', { status: vault.status })

  const owned = item({ shared_vault_uuid: vaultUuid })
  const write = await sync(owner, { items: [owned] })
  const savedByOwner = (write.json?.saved_items ?? []).some((i) => i.uuid === owned.uuid)
  say('the OWNER can write an item into its own shared vault', savedByOwner ? 'YES ' : 'NO  ', {
    status: write.status,
    saved: (write.json?.saved_items ?? []).length,
    conflicts: (write.json?.conflicts ?? []).map((c) => c.type),
    body: savedByOwner ? undefined : write.text.slice(0, 400),
  })

  // ---- member-only reads, BEFORE acceptance (the controls) ----------------
  const usersBefore = await raw('GET', `/v1/shared-vaults/${vaultUuid}/users`, {
    token: member.token,
    cookie: member.cookie,
  })
  say('BEFORE acceptance the member-only user list is refused (control)', usersBefore.status >= 400 ? 'ctrl' : 'NO  ', {
    status: usersBefore.status,
    body: usersBefore.text.slice(0, 200),
  })
  const valetBefore = await raw('POST', `/v1/shared-vaults/${vaultUuid}/valet-tokens`, {
    token: member.token,
    cookie: member.cookie,
    body: { operation: 'write', resources: [{ remoteIdentifier: randomUUID(), unencryptedFileSize: 16 }] },
  })
  say('BEFORE acceptance a write valet token is refused (control)', valetBefore.status >= 400 ? 'ctrl' : 'NO  ', {
    status: valetBefore.status,
    body: valetBefore.text.slice(0, 200),
  })

  // CONTROL: before accepting, the invited member must NOT see the item.
  const beforeAccept = await sync(member, { items: [] })
  const seenBefore = (beforeAccept.json?.retrieved_items ?? []).some((i) => i.uuid === owned.uuid)
  say('BEFORE accepting, the member cannot read the vault item (control)', !seenBefore ? 'ctrl' : 'NO  ', {
    status: beforeAccept.status,
    retrieved: (beforeAccept.json?.retrieved_items ?? []).length,
  })

  const invite = await raw('POST', `/v1/shared-vaults/${vaultUuid}/invites`, {
    token: owner.token,
    cookie: owner.cookie,
    body: {
      recipient_uuid: member.uuid,
      encrypted_message: '004:' + randomBytes(64).toString('base64'),
      permission: 'write',
    },
  })
  const inviteUuid = invite.json?.invite?.uuid
  say('the owner invited the member (setup)', inviteUuid ? 'ctrl' : 'NO  ', { status: invite.status })

  // CONTROL: a pending invite alone must not grant access.
  const whilePending = await sync(member, { items: [] })
  say('a PENDING invite alone does not grant read access (control)', !(whilePending.json?.retrieved_items ?? []).some((i) => i.uuid === owned.uuid) ? 'ctrl' : 'NO  ', {
    retrieved: (whilePending.json?.retrieved_items ?? []).length,
  })

  const accept = await raw('POST', `/v1/shared-vaults/${vaultUuid}/invites/${inviteUuid}/accept`, {
    token: member.token,
    cookie: member.cookie,
    body: {},
  })
  say('the member accepted', accept.status === 200 ? 'YES ' : 'NO  ', { status: accept.status })

  // ---- the SAME member-only reads, AFTER acceptance (the present successes) --
  const usersAfter = await raw('GET', `/v1/shared-vaults/${vaultUuid}/users`, {
    token: member.token,
    cookie: member.cookie,
  })
  const memberRow = (usersAfter.json?.users ?? []).find((u) => u.user_uuid === member.uuid)
  say('AFTER acceptance the member can read the vault user list AND is in it with write permission', usersAfter.status === 200 && memberRow?.permission === 'write' ? 'YES ' : 'NO  ', {
    status: usersAfter.status,
    permission: memberRow?.permission,
    users: (usersAfter.json?.users ?? []).length,
    body: memberRow ? undefined : usersAfter.text.slice(0, 250),
  })
  const valetAfter = await raw('POST', `/v1/shared-vaults/${vaultUuid}/valet-tokens`, {
    token: member.token,
    cookie: member.cookie,
    body: { operation: 'write', resources: [{ remoteIdentifier: randomUUID(), unencryptedFileSize: 16 }] },
  })
  say('AFTER acceptance the member is granted a WRITE valet token for the vault', valetAfter.status === 200 && typeof (valetAfter.json?.tokens?.[0]?.valetToken ?? valetAfter.json?.valetToken) === 'string' ? 'YES ' : 'NO  ', {
    status: valetAfter.status,
    body: valetAfter.text.slice(0, 250),
  })

  const afterAccept = await sync(member, { items: [] })
  const seenAfter = (afterAccept.json?.retrieved_items ?? []).some((i) => i.uuid === owned.uuid)
  say('AFTER accepting, the member CAN read the vault item', seenAfter ? 'YES ' : 'NO  ', {
    status: afterAccept.status,
    retrieved: (afterAccept.json?.retrieved_items ?? []).length,
    sharedVaults: (afterAccept.json?.shared_vaults ?? []).map((v) => v.uuid),
  })

  const memberItem = item({ shared_vault_uuid: vaultUuid })
  const memberWrite = await sync(member, { items: [memberItem], sync_token: afterAccept.json?.sync_token ?? null })
  const memberSaved = (memberWrite.json?.saved_items ?? []).some((i) => i.uuid === memberItem.uuid)
  say('AFTER accepting, the member CAN write into the vault', memberSaved ? 'YES ' : 'NO  ', {
    status: memberWrite.status,
    saved: (memberWrite.json?.saved_items ?? []).length,
    conflicts: (memberWrite.json?.conflicts ?? []).map((c) => c.type),
    body: memberSaved ? undefined : memberWrite.text.slice(0, 400),
  })

  const ownerSees = await sync(owner, { items: [] })
  say('the owner can read the item the member wrote', (ownerSees.json?.retrieved_items ?? []).some((i) => i.uuid === memberItem.uuid) ? 'YES ' : 'NO  ', {
    retrieved: (ownerSees.json?.retrieved_items ?? []).length,
  })
}

main().catch((e) => {
  console.error('PROBE CRASHED: vault access did not complete')
  process.exitCode = 1
})
