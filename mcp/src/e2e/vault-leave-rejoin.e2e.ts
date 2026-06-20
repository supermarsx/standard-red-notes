import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// DEEP integration e2e: the full membership lifecycle of an end-to-end encrypted
// SHARED VAULT — leave, owner-remove, and rejoin.
//
//   A & B trust each other -> A creates a shared vault, invites B (write) ->
//   B accepts and sees A's note ->
//   (1) B LEAVES the vault (app.vaultUsers.leaveSharedVault) -> B loses the
//       vault + its notes locally; A keeps them ->
//   (2) A RE-INVITES B, B accepts again -> B regains access AND sees a NEW note
//       A wrote while B was gone ->
//   (3) A (owner) REMOVES B (app.vaultUsers.removeUserFromSharedVault) -> B
//       loses access again; A keeps the vault.
//
// Vault membership APIs used (discovered in @standardnotes/snjs VaultUserService):
//   - app.vaultUsers.leaveSharedVault(sharedVault)            -> self-leave
//   - app.vaultUsers.removeUserFromSharedVault(vault, uuid)   -> owner removes a member
//   - app.vaultUsers.getSharedVaultUsersFromServer(vault)     -> authoritative member list
//   - app.vaultUsers.isCurrentUserSharedVaultOwner(vault)

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

// B accepts A's inbound invite for `sharedVaultUuid`. Returns true once accepted.
async function acceptInvite(
  B: { app: { sync(): Promise<void>; app: any }; },
  sharedVaultUuid: string,
): Promise<boolean> {
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

  // 0. Self contacts + mutual trust.
  const selfA = await ensureSelfContact(A.app)
  const selfB = await ensureSelfContact(B.app)
  check('both accounts have a self (me) contact', selfA && selfB)

  const collabA = appA.contacts.getCollaborationID()
  const collabB = appB.contacts.getCollaborationID()
  const trustedB = await appA.contacts.addTrustedContactFromCollaborationID(collabB, 'Human')
  const trustedA = await appB.contacts.addTrustedContactFromCollaborationID(collabA, 'Agent')
  check('A trusts B and B trusts A', !!trustedB && !!trustedA)

  // 1. A creates a shared vault and invites B (write).
  const vault = await appA.vaults.createRandomizedVault({ name: 'Lifecycle Vault', iconString: '🔁' })
  await A.app.sync()
  const shared = await appA.sharedVaults.convertVaultToSharedVault(vault)
  check('A created a shared vault', !!shared?.sharing?.sharedVaultUuid)
  await A.app.sync()
  const sharedVaultUuid = shared.sharing.sharedVaultUuid

  const invite1 = await appA.vaultInvites.inviteContactToSharedVault(shared, trustedB, 'write')
  check('A invited B (write)', invite1?.isFailed?.() === false)
  await A.app.sync()

  const joined1 = await acceptInvite(B, sharedVaultUuid)
  check('B accepted the invite (joined the vault)', joined1)

  // 2. A writes a note; B must see + decrypt it.
  const note1 = await clientA.createNote({ title: 'Original', body: 'first shared note', tags: [], vault: shared.uuid })
  await A.app.sync()

  const seen1 = await pollFor('B sees note1', async () => {
    await B.app.sync()
    return (await clientB.listNotes(100)).notes.find((n) => n.uuid === note1.uuid)
  })
  check('B is a member and sees the first shared note', !!seen1)

  // Confirm B appears in the server-side member list.
  const membersBefore = await appA.vaultUsers.getSharedVaultUsersFromServer(shared)
  check('server member list includes B before leaving', Array.isArray(membersBefore) && membersBefore.length >= 2)
  const bServerUser = (membersBefore ?? []).find(
    (u: { user_uuid: string }) => u.user_uuid === appB.sessions.getSureUser().uuid,
  )
  check('B found in server member list', !!bServerUser)

  // === (1) B LEAVES THE VAULT ===
  // The VaultListing UUID is per-account; cross-account the shared vault is keyed
  // by sharing.sharedVaultUuid. leaveSharedVault looks the vault up in B's OWN
  // local items, so pass B's local vault-listing object.
  const findBySharedUuid = (app: any) =>
    app.vaults.getVaults().find((v: any) => v.sharing?.sharedVaultUuid === sharedVaultUuid)
  const bVault = findBySharedUuid(appB)
  check('B has a local copy of the shared vault before leaving', !!bVault)
  const leaveRes = await appB.vaultUsers.leaveSharedVault(bVault)
  check('leaveSharedVault did not return a displayable error', !leaveRes || leaveRes.isFailed === undefined || leaveRes.isFailed?.() === false)
  await B.app.sync()
  await sleep(1500)
  await B.app.sync()

  // After leaving, B's local copy of the vault and its notes are deleted
  // (LeaveVault use case runs _deleteThirdPartyVault).
  const bHasVaultAfterLeave = !!findBySharedUuid(appB)
  check('B no longer has the vault after leaving', !bHasVaultAfterLeave)
  const bSeesNoteAfterLeave = (await clientB.listNotes(200)).notes.some((n) => n.uuid === note1.uuid)
  check('B can no longer see the shared note after leaving', !bSeesNoteAfterLeave)

  // A still owns the vault and keeps the note.
  await A.app.sync()
  const aHasVaultAfterLeave = !!findBySharedUuid(appA)
  const aSeesNoteAfterLeave = (await clientA.listNotes(200)).notes.some((n) => n.uuid === note1.uuid)
  check('A still has the vault and note after B left', aHasVaultAfterLeave && aSeesNoteAfterLeave)

  // Server member list no longer includes B.
  const membersAfterLeave = await appA.vaultUsers.getSharedVaultUsersFromServer(shared)
  const bStillMember = (membersAfterLeave ?? []).some(
    (u: { user_uuid: string }) => u.user_uuid === appB.sessions.getSureUser().uuid,
  )
  check('server member list no longer includes B after leave', !bStillMember)

  // === (2) B REJOINS: A re-invites, B accepts ===
  // Refresh A's view of the (root-key-rotated) shared vault before re-inviting.
  await A.app.sync()
  const sharedRefetch = findBySharedUuid(appA) ?? shared
  const invite2 = await appA.vaultInvites.inviteContactToSharedVault(sharedRefetch, trustedB, 'write')
  check('A re-invited B', invite2?.isFailed?.() === false)
  await A.app.sync()

  // A also writes a NEW note while B is still away — B should get it on rejoin.
  const note2 = await clientA.createNote({ title: 'Added while gone', body: 'written before B rejoined', tags: [], vault: shared.uuid })
  await A.app.sync()

  const rejoined = await acceptInvite(B, sharedVaultUuid)
  check('B accepted the re-invite (rejoined)', rejoined)

  const seenOld = await pollFor('B re-sees note1 after rejoin', async () => {
    await B.app.sync()
    return (await clientB.listNotes(200)).notes.find((n) => n.uuid === note1.uuid)
  })
  check('after rejoin B sees the original note again', !!seenOld)

  const seenNew = await pollFor('B sees note2 (added while gone)', async () => {
    await B.app.sync()
    return (await clientB.listNotes(200)).notes.find((n) => n.uuid === note2.uuid)
  })
  check('after rejoin B sees the note A added while B was gone', !!seenNew)

  // === (3) A (owner) REMOVES B ===
  check('A is the vault owner', appA.vaultUsers.isCurrentUserSharedVaultOwner(sharedRefetch) === true)
  const removeRes = await appA.vaultUsers.removeUserFromSharedVault(sharedRefetch, appB.sessions.getSureUser().uuid)
  check('owner removeUserFromSharedVault succeeded', removeRes?.isFailed?.() === false)
  await A.app.sync()
  await sleep(1500)

  const membersAfterRemove = await appA.vaultUsers.getSharedVaultUsersFromServer(sharedRefetch)
  const bMemberAfterRemove = (membersAfterRemove ?? []).some(
    (u: { user_uuid: string }) => u.user_uuid === appB.sessions.getSureUser().uuid,
  )
  check('server member list no longer includes B after owner-remove', !bMemberAfterRemove)

  // B, after syncing, loses access to the vault locally.
  await B.app.sync()
  await sleep(1500)
  await B.app.sync()
  const bHasVaultAfterRemove = !!findBySharedUuid(appB)
  check('B no longer has the vault after being removed by the owner', !bHasVaultAfterRemove)

  // A keeps the vault + both notes.
  const aIntactAfterRemove =
    !!findBySharedUuid(appA) &&
    (await clientA.listNotes(200)).notes.some((n) => n.uuid === note1.uuid)
  check('A still owns the vault and its notes after removing B', aIntactAfterRemove)

  await cleanup(B.app, B.dataDir)
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
