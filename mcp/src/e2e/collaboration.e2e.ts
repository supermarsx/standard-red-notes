import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// DEEP integration e2e: two separate accounts collaborate in an end-to-end
// encrypted SHARED VAULT — the headline "agent + human collaboration" feature.
// Exercises the full trust/key-exchange path: trusted contacts, vault sharing,
// invite + accept, and bidirectional propagation of encrypted notes.
//
//   A & B exchange collaboration IDs and trust each other ->
//   A creates a vault, converts it to a shared vault, invites B (write) ->
//   B downloads the inbound invite and accepts (gets the vault key) ->
//   A writes a note in the vault -> B syncs and DECRYPTS it ->
//   B edits it -> A syncs and sees B's edit.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// The "me"/self contact is created by an event-driven SelfContactManager once the
// account has a key pair. Inviting requires it; nudge it via sync and, if it
// hasn't materialized, create it explicitly from the session's public keys.
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

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // Two independent accounts: A is the agent/bridge, B is a human collaborator.
  const A = await freshAccount()
  const B = await freshAccount()
  const appA = A.app.app
  const appB = B.app.app
  const clientA = new SnjsBackedClient(A.app, { allowWrites: true, baseUrl: SERVER })
  const clientB = new SnjsBackedClient(B.app, { allowWrites: true, baseUrl: SERVER })

  // 0. Both accounts need a self ("me") contact before they can share/invite.
  const selfA = await ensureSelfContact(A.app)
  const selfB = await ensureSelfContact(B.app)
  check('both accounts have a self (me) contact', selfA && selfB)

  // 1. Exchange collaboration IDs and establish mutual trust.
  const collabA = appA.contacts.getCollaborationID()
  const collabB = appB.contacts.getCollaborationID()
  check('both accounts produced a collaboration ID', !!collabA && !!collabB && collabA !== collabB)

  const trustedB = await appA.contacts.addTrustedContactFromCollaborationID(collabB, 'Human')
  const trustedA = await appB.contacts.addTrustedContactFromCollaborationID(collabA, 'Agent')
  check('A trusts B and B trusts A', !!trustedB && !!trustedA)

  // 2. A creates a vault and converts it into a shared (collaborative) vault.
  const vault = await appA.vaults.createRandomizedVault({ name: 'Team Space', iconString: '🤝' })
  await A.app.sync()
  const shared = await appA.sharedVaults.convertVaultToSharedVault(vault)
  check('A converted the vault into a shared vault', !!shared && !!shared.sharing?.sharedVaultUuid)
  await A.app.sync()

  // 3. A invites B (write permission).
  const invitable = await appA.vaultInvites.getInvitableContactsForSharedVault(shared)
  check('B is an invitable contact for the shared vault', invitable.some((c: { contactUuid: string }) => c.contactUuid === trustedB.contactUuid))
  const inviteResult = await appA.vaultInvites.inviteContactToSharedVault(shared, trustedB, 'write')
  if (inviteResult?.isFailed?.()) {
    console.log('  INVITE ERROR:', inviteResult.getError?.())
  }
  check('A sent a write invite to B', inviteResult?.isFailed?.() === false)
  await A.app.sync()

  // 4. B receives the inbound invite and accepts it (acquiring the vault key).
  const record = await pollFor('B inbound invite', async () => {
    await B.app.sync()
    await appB.vaultInvites.downloadInboundInvites()
    const records = appB.vaultInvites.getCachedPendingInviteRecords()
    return records.find((r: { invite: { shared_vault_uuid: string }; trusted: boolean }) => r.invite.shared_vault_uuid === shared.sharing.sharedVaultUuid)
  })
  check('B received the inbound invite', !!record)
  check('the invite is trusted (A is a known contact)', record?.trusted === true)
  const accepted = await appB.vaultInvites.acceptInvite(record!)
  check('B accepted the invite', accepted?.isFailed?.() === false)
  await B.app.sync()

  // 5. A writes a note INTO the shared vault; B must see and decrypt it.
  const note = await clientA.createNote({ title: 'Shared plan', body: 'agent wrote this in the shared vault', tags: ['team'], vault: shared.uuid })
  await A.app.sync()

  const seenByB = await pollFor('B sees the shared note', async () => {
    await B.app.sync()
    const list = await clientB.listNotes(100)
    return list.notes.find((n) => n.uuid === note.uuid)
  })
  check('B sees the note A created in the shared vault', !!seenByB)
  if (seenByB) {
    const read = await clientB.readNote(note.uuid)
    check('B decrypted the shared note body + vault', read.body === 'agent wrote this in the shared vault' && read.vault === 'Team Space')
  }

  // 6. Bidirectional: B edits the shared note; A must see B's edit.
  await clientB.updateNote(note.uuid, { body: 'human edited the shared note' })
  await B.app.sync()

  const editSeenByA = await pollFor('A sees B edit', async () => {
    await A.app.sync()
    const read = await clientA.readNote(note.uuid).catch(() => undefined)
    return read && read.body === 'human edited the shared note' ? read : undefined
  })
  check('A sees B\'s edit to the shared note (bidirectional collaboration)', !!editSeenByA)

  await cleanup(B.app, B.dataDir)
  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
