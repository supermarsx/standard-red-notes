import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { check, finish, freshAccount, SERVER, serverUp } from './helpers.js'

// Bundled to CJS by run-e2e.mjs, so __dirname is the dist/e2e output dir.
declare const __dirname: string

// END-TO-END through the REAL MCP server: spawn dist/index.cjs over stdio, speak
// the actual MCP protocol with a real Client, and exercise every tool. This is
// the only test that proves the server itself works (tool registration, schemas,
// lazy account bootstrap, structured output) — the other suites call the backing
// client class directly and bypass the server entirely.

const EXPECTED_TOOLS = [
  'standard_red_notes_status',
  'notes.list',
  'notes.search',
  'notes.read',
  'notes.create',
  'notes.update',
  'notes.delete',
  'tags.list',
  'vaults.list',
  'vaults.create',
]

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean }

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log('SKIP: server not reachable on', SERVER)
    process.exit(0)
  }

  // Pre-register a throwaway account, then release the data dir so the spawned
  // server launches into it and restores/sign-ins the same account.
  const { app, email, password, dataDir } = await freshAccount()
  await app.deinit()

  const serverPath = path.join(__dirname, '..', 'index.cjs')
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: {
      ...(process.env as Record<string, string>),
      STANDARD_RED_NOTES_SERVER_URL: SERVER,
      STANDARD_RED_NOTES_EMAIL: email,
      STANDARD_RED_NOTES_PASSWORD: password,
      STANDARD_RED_NOTES_DATA_DIR: dataDir,
      STANDARD_RED_NOTES_ALLOW_WRITES: '1',
      STANDARD_RED_NOTES_ALLOW_REGISTER: '0',
      STANDARD_RED_NOTES_SYNC_INTERVAL_MS: '0',
    },
  })
  const client = new Client({ name: 'srn-e2e', version: '1.0.0' })
  await client.connect(transport)

  // Protocol: the server advertises all its tools.
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  check('server lists all 10 tools', EXPECTED_TOOLS.every((t) => names.includes(t)))

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const res = (await client.callTool({ name, arguments: args })) as ToolResult
    if (res.isError) {
      throw new Error(`tool ${name} errored: ${JSON.stringify(res)}`)
    }
    return res.structuredContent ?? {}
  }

  // Liveness through the real server: status reports a signed-in, writable bridge.
  const status = await call('standard_red_notes_status')
  check('status: bridge ready', status.status === 'ready')
  check('status: account signed in (liveness)', status.signedIn === true)
  check('status: writes enabled', status.writes === true)

  // Full tool round-trip over the protocol.
  const created = await call('notes.create', { title: 'MCP e2e note', body: 'hello over stdio', tags: ['proto'] })
  const uuid = created.uuid as string
  check('notes.create returns a uuid', typeof uuid === 'string' && uuid.length > 0)

  const read = await call('notes.read', { uuid })
  check('notes.read returns the note body + tag', read.body === 'hello over stdio' && (read.tags as string[]).includes('proto'))

  const list = await call('notes.list', { limit: 50 })
  check('notes.list includes the created note', (list.notes as { uuid: string }[]).some((n) => n.uuid === uuid))

  const search = await call('notes.search', { query: 'stdio', limit: 10 })
  check('notes.search finds it by body', (search.hits as { uuid: string }[]).some((h) => h.uuid === uuid))

  const updated = await call('notes.update', { uuid, body: 'edited over stdio', tags: ['edited'] })
  check('notes.update returns uuid + updatedAt', updated.uuid === uuid && typeof updated.updatedAt === 'string')
  const reread = await call('notes.read', { uuid })
  check('notes.update persisted the new body + tag', reread.body === 'edited over stdio' && (reread.tags as string[]).includes('edited'))

  const tags = await call('tags.list')
  check('tags.list includes the note tags', (tags.tags as { title: string }[]).some((t) => t.title === 'proto'))

  const vault = await call('vaults.create', { name: 'MCP Vault' })
  const vaultUuid = vault.uuid as string
  check('vaults.create returns a uuid', typeof vaultUuid === 'string' && vaultUuid.length > 0)
  const vlist = await call('vaults.list')
  check('vaults.list includes the new vault', (vlist.vaults as { uuid: string }[]).some((v) => v.uuid === vaultUuid))
  const vnote = await call('notes.create', { title: 'In vault', body: 'v', tags: [], vault: vaultUuid })
  const vread = await call('notes.read', { uuid: vnote.uuid })
  check('note created into a vault reads back in that vault', vread.vault === 'MCP Vault')

  const del = await call('notes.delete', { uuid })
  check('notes.delete reports deleted', del.deleted === true)
  const afterDelete = await call('notes.list', { limit: 50 })
  check('deleted note no longer listed', !(afterDelete.notes as { uuid: string }[]).some((n) => n.uuid === uuid))

  // A write tool must refuse when writes are disabled — verify the guard end-to-end.
  await client.close()
  const roTransport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: {
      ...(process.env as Record<string, string>),
      STANDARD_RED_NOTES_SERVER_URL: SERVER,
      STANDARD_RED_NOTES_EMAIL: email,
      STANDARD_RED_NOTES_PASSWORD: password,
      STANDARD_RED_NOTES_DATA_DIR: dataDir,
      STANDARD_RED_NOTES_ALLOW_WRITES: '0',
      STANDARD_RED_NOTES_ALLOW_REGISTER: '0',
      STANDARD_RED_NOTES_SYNC_INTERVAL_MS: '0',
    },
  })
  const roClient = new Client({ name: 'srn-e2e-ro', version: '1.0.0' })
  await roClient.connect(roTransport)
  const roResult = (await roClient.callTool({
    name: 'notes.create',
    arguments: { title: 'should fail', body: '', tags: [] },
  })) as ToolResult
  check('write tool is rejected when writes are disabled', roResult.isError === true)
  await roClient.close()

  finish()
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
