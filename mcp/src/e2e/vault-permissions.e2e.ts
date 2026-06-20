import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// DEEP integration e2e: shared-vault PERMISSION model. A read-only member must
// not be able to mutate vault items (the server rejects the write with a
// `readonly_error` conflict and the edit does NOT propagate to the owner), while
// a write member's edit DOES propagate.
//
//   A creates a shared vault + a note ->
//   A invites B as READ-ONLY, B accepts and can READ the note ->
//   B attempts to edit the note + sync -> the owner A never sees B's edit, and
//     the server reports B as a read-only member ->
//   A re-grants B WRITE (re-invite as write — the simplest supported role change)
//     -> B's edit now propagates to A.
//
// APIs used:
//   - app.vaultInvites.inviteContactToSharedVault(vault, contact, 'read'|'write')
//   - app.vaultUsers.isCurrentUserReadonlyVaultMember(vault)  (on B's app)
//   - app.vaultUsers.getSharedVaultUsersFromServer(vault)     (permission field)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function ensureSelfContact(headless: { app: unknown; sync: () => Promise<void> }): Promise<boolean> {
  const app = headless.app as {
    contacts: { getSelfContact(): unknown; createOrEditTrustedContact(p: Record<string, unknown>): Promise<unknown> }
    sessions: { getSureUser(): { uuid: string }; getPublicKey(): string; getSigningPublicKey(): string }
  }
  for (let i = 0; i < 8; i++) {
    if (app.contacts.getSelfContact()) return true
    await headless.sync()
    await sleep(500)
  }
  if (!app.contacts.getSelfContact()) {
    const user = app.sessions.getSureUser()
    await app.contacts.createOrEditTrustedContact({
      contactUuid: user.uuid,
      name: 'Me',
      publicKey: app.sessions.getPublicKey(),
      signingPublicKey: app.sessions.getSigningPublicKey(),
      isMe: true,
    })
    await headless.sync()
  }
  return !!app.contacts.getSelfContact()
}

async function pollFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 25000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v !== undefined) return v
    await sleep(1000)
  }
  console.log(`  (timed out polling for ${label})`)
  return undefined
}

async function acceptInvite(B: { app: { sync(): Promise<void>; app: any } }, sharedVaultUuid: string): Promise<boolean> {
  const appB = B.app.app
  const record = await pollFor('B inbound invite', async () => {
    await B.app.sync()
    await appB.vaultInvites.downloadInboundInvites()
    const records = appB.vaultInvites.getCachedPendingInviteRecords()
    return records.find((r: { invite: { shared_vault_uuid: string } }) => r.invite.shared_vault_uuid === sharedVaultUuid)
  })
  if (!record) return false
  const accepted = await appB.vaultInvites.acceptInvite(record)
  await B.app.sync()
  return accepted?.isFailed?.() === false
}

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const A = await freshAccount()
  const B = await freshAccount()
  const appA = A.app.app
  const appB = B.app.app
  const clientA = new SnjsBackedClient(A.app, { allowWrites: true, baseUrl: SERVER })
  const clientB = new SnjsBackedClient(B.app, { allowWrites: true, baseUrl: SERVER })

  const selfA = await ensureSelfContact(A.app)
  const selfB = await ensureSelfContact(B.app)
  check('both accounts have a self (me) contact', selfA && selfB)

  const collabA = appA.contacts.getCollaborationID()
  const collabB = appB.contacts.getCollaborationID()
  const trustedB = await appA.contacts.addTrustedContactFromCollaborationID(collabB, 'Reader')
  await appB.contacts.addTrustedContactFromCollaborationID(collabA, 'Owner')
  check('A trusts B and B trusts A', !!trustedB)

  // A creates a shared vault with a note.
  const vault = await appA.vaults.createRandomizedVault({ name: 'Perms Vault', iconString: '🔐' })
  await A.app.sync()
  const shared = await appA.sharedVaults.convertVaultToSharedVault(vault)
  await A.app.sync()
  const sharedVaultUuid = shared.sharing.sharedVaultUuid

  const note = await clientA.createNote({ title: 'RO note', body: 'owner body v1', tags: [], vault: shared.uuid })
  await A.app.sync()

  // === Invite B as READ-ONLY ===
  const inviteRO = await appA.vaultInvites.inviteContactToSharedVault(shared, trustedB, 'read')
  check('A invited B as read-only', inviteRO?.isFailed?.() === false)
  await A.app.sync()

  const joined = await acceptInvite(B, sharedVaultUuid)
  check('B accepted the read-only invite', joined)

  // B can READ the note.
  const seen = await pollFor('B sees the note', async () => {
    await B.app.sync()
    return (await clientB.listNotes(100)).notes.find((n) => n.uuid === note.uuid)
  })
  check('read-only member B can READ the shared note', !!seen)
  if (seen) {
    const read = await clientB.readNote(note.uuid)
    check('B read the correct (owner) body', read.body === 'owner body v1')
  }

  // The server / snjs classifies B as a read-only member.
  // (VaultListing UUID is per-account; match by sharing.sharedVaultUuid.)
  const findBySharedUuid = (app: any) =>
    app.vaults.getVaults().find((v: any) => v.sharing?.sharedVaultUuid === sharedVaultUuid)
  check('B is classified as a read-only vault member',
    appB.vaultUsers.isCurrentUserReadonlyVaultMember(findBySharedUuid(appB)) === true)
  const membersRO = await appA.vaultUsers.getSharedVaultUsersFromServer(shared)
  const bUser = (membersRO ?? []).find((u: { user_uuid: string }) => u.user_uuid === appB.sessions.getSureUser().uuid)
  check('server reports B with read permission', bUser?.permission === 'read')

  // === B (read-only) ATTEMPTS a write — must be rejected ===
  // Edit the item directly + sync. The server rejects the change for a read-only
  // member (readonly_error conflict); the owner must NEVER observe B's text.
  const bNote = appB.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === note.uuid)
  if (bNote) {
    await appB.mutator.changeItem(bNote, (m: { text: string }) => {
      m.text = 'read-only tried to overwrite'
    })
    await B.app.sync().catch(() => {})
    await sleep(1500)
    await B.app.sync().catch(() => {})
  }

  // Owner A must still see the original body (the read-only write did not land).
  let ownerBodyUnchanged = true
  for (let i = 0; i < 8; i++) {
    await A.app.sync()
    const read = await clientA.readNote(note.uuid)
    if (read.body === 'read-only tried to overwrite') {
      ownerBodyUnchanged = false
      break
    }
    await sleep(800)
  }
  check('owner does NOT see the read-only member\'s rejected write', ownerBodyUnchanged)

  // === A re-grants B WRITE access (role change via re-invite) ===
  // Removing the read-only user then re-inviting as write is the supported flow
  // for changing a member's permission level in this snjs build.
  await appA.vaultUsers.removeUserFromSharedVault(shared, appB.sessions.getSureUser().uuid)
  await A.app.sync()
  await sleep(1500)
  await B.app.sync()
  await sleep(1000)

  const sharedRefetch = findBySharedUuid(appA) ?? shared
  const inviteRW = await appA.vaultInvites.inviteContactToSharedVault(sharedRefetch, trustedB, 'write')
  check('A re-invited B as write', inviteRW?.isFailed?.() === false)
  await A.app.sync()
  const rejoinedWrite = await acceptInvite(B, sharedVaultUuid)
  check('B accepted the write invite', rejoinedWrite)

  // Now B's edit MUST propagate to A.
  const bNote2 = await pollFor('B has the note as write member', async () => {
    await B.app.sync()
    return appB.items.getDisplayableNotes().find((n: { uuid: string }) => n.uuid === note.uuid)
  })
  check('B (now write) has the note locally', !!bNote2)
  if (bNote2) {
    await appB.mutator.changeItem(bNote2, (m: { text: string }) => {
      m.text = 'write member edit landed'
    })
    await B.app.sync()
  }
  const ownerSawWrite = await pollFor('A sees write member edit', async () => {
    await A.app.sync()
    const read = await clientA.readNote(note.uuid).catch(() => undefined)
    return read && read.body === 'write member edit landed' ? read : undefined
  })
  check('write member B\'s edit DOES propagate to the owner', !!ownerSawWrite)

  await cleanup(B.app, B.dataDir)
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
