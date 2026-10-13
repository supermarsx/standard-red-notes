import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const memoryQueues = new WeakMap<object, Promise<void>>()
const fileQueues = new Map<string, Promise<void>>()
let activeQueueKeyCount = 0

export function sharedSqliteTransactionQueueStatsForTesting() {
  return { activeQueueKeyCount, sqliteFileQueueCount: fileQueues.size }
}

/** SQLite services in one process may use DIFFERENT DataSources for the SAME
 * file. Serialize their explicit transactions together: a synchronous busy
 * wait on connection B otherwise prevents connection A's async commit. This
 * queue is shared by auth and syncing; database locks coordinate other processes.
 * Callbacks must contain database work only, never external I/O. */
export async function runSharedSqliteTransaction<T>(
  source: object,
  database: string,
  work: () => Promise<T>,
): Promise<T> {
  return database === ':memory:'
    ? runQueue(memoryQueues, source, work)
    : runQueue(fileQueues, sqliteDatabaseKey(database), work)
}

type Queue<Key> = {
  get(key: Key): Promise<void> | undefined
  set(key: Key, value: Promise<void>): unknown
  delete(key: Key): unknown
}

async function runQueue<T, Key>(queues: Queue<Key>, key: Key, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  if (!queues.get(key)) {activeQueueKeyCount++}
  let release!: () => void
  const current = new Promise<void>((done) => {
    release = done
  })
  queues.set(key, current)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (queues.get(key) === current) {
      queues.delete(key)
      activeQueueKeyCount--
    }
  }
}

function sqliteDatabaseKey(database: string): string {
  let path = database
  if (database.startsWith('file://')) {
    path = fileURLToPath(database)
  } else if (database.startsWith('file:')) {
    const [name, query] = database.slice(5).split('?', 2)
    const parameters = new URLSearchParams(query)
    if (parameters.get('mode') === 'memory' || name === ':memory:') {
      parameters.sort()
      return `sqlite-memory-uri:${name}?${parameters.toString()}`
    }
    path = decodeURIComponent(name)
  }
  const absolute = resolve(path)
  let canonical = absolute
  try {
    canonical = realpathSync.native(absolute)
  } catch {
    /* New files still share their resolved path. */
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}
