import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// Verifies the single-tier "everyone is Pro" server fix: role-gated features are
// unlocked for a plain free account. The directly observable one is the SHARED
// VAULT COUNT — free (CoreUser) accounts were capped at 1 shared vault; a Pro
// grant lifts the cap. (The same cross-service-token Pro grant also unlocks full
// revision history and removes the content-size limit, which aren't practically
// e2e-testable — they need 30+ day-old revisions / >100MB of content.)

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

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  const A = await freshAccount()
  const appA = A.app.app
  check('self contact ready', await ensureSelfContact(A.app))

  // Create several shared vaults. A free CoreUser was limited to ONE — the 2nd+
  // conversions only succeed once the account is treated as Pro.
  const created: string[] = []
  for (let i = 1; i <= 3; i++) {
    const vault = await appA.vaults.createRandomizedVault({ name: `Vault ${i}`, iconString: '🔒' })
    await A.app.sync()
    const shared = await appA.sharedVaults.convertVaultToSharedVault(vault)
    const ok = shared && !shared.isFailed?.() && !!shared.sharing?.sharedVaultUuid
    check(`shared vault #${i} created (no free-tier 1-vault cap)`, !!ok)
    if (ok) created.push(shared.sharing.sharedVaultUuid)
    await A.app.sync()
  }

  check('at least 3 shared vaults exist on a free account', created.length === 3)
  const client = new SnjsBackedClient(A.app, { allowWrites: true, baseUrl: SERVER })
  const vaults = await client.listVaults()
  const sharedCount = vaults.filter((v) => v.shared).length
  check('listVaults reports the 3 shared vaults', sharedCount >= 3)

  await cleanup(A.app, A.dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
