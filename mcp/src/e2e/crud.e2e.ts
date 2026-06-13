import { check, cleanup, finish, freshAccount, SERVER, serverUp } from './helpers.js'
import { SnjsBackedClient } from '../snjs/SnjsBackedClient.js'

// Full CRUD + vaults against the live server, asserting SERVER-SIDE persistence.
async function main() {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }
  const { app, dataDir } = await freshAccount()
  const client = new SnjsBackedClient(app, { allowWrites: true, baseUrl: SERVER })

  const a = await client.createNote({ title: 'Shopping', body: 'milk, eggs', tags: ['errands'] })
  const b = await client.createNote({ title: 'Ideas', body: 'build a bridge', tags: ['work'] })
  check('createNote returns uuids', !!a.uuid && !!b.uuid)

  const list = await client.listNotes(10)
  check('listNotes returns both notes', list.notes.length === 2)

  const read = await client.readNote(a.uuid)
  check('readNote returns title/body/tags', read.title === 'Shopping' && read.body === 'milk, eggs' && read.tags.includes('errands'))

  const search = await client.searchNotes('eggs', 5)
  check('searchNotes finds by body', search.hits.some((h) => h.uuid === a.uuid))

  await client.updateNote(a.uuid, { body: 'milk, eggs, bread', tags: ['urgent'] })
  const reread = await client.readNote(a.uuid)
  check('updateNote persists body + tag', reread.body === 'milk, eggs, bread' && reread.tags.includes('urgent'))

  const tags = await client.listTags()
  check('listTags returns created tags', tags.some((t) => t.title === 'errands') && tags.some((t) => t.title === 'work'))

  const vault = await client.createVault('Team', 'shared')
  check('createVault returns a vault', !!vault.uuid)
  const vnote = await client.createNote({ title: 'In vault', body: 'x', tags: ['shared'], vault: vault.uuid })
  const vread = await client.readNote(vnote.uuid)
  check('note routed into the vault', vread.vault === 'Team')

  await client.deleteNote(b.uuid)
  const afterDelete = await client.listNotes(10)
  check('deleteNote removes the note', !afterDelete.notes.some((n) => n.uuid === b.uuid))

  await cleanup(app, dataDir)
  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
