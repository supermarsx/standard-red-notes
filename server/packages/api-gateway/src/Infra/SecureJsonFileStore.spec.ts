import { promises as fs, Stats } from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  defaultSecureJsonFileOperations,
  isJsonObject,
  SecureJsonFileHandle,
  SecureJsonFileOperations,
  SecureJsonFileStore,
} from './SecureJsonFileStore'

type TestShape = Record<string, number>

const isTestShape = (value: unknown): value is TestShape =>
  isJsonObject(value) && Object.values(value).every((entry) => typeof entry === 'number')

describe('SecureJsonFileStore', () => {
  let directoryPath: string
  let filePath: string

  beforeEach(async () => {
    directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-json-store-'))
    filePath = path.join(directoryPath, 'state.json')
  })

  afterEach(async () => {
    await fs.rm(directoryPath, { recursive: true, force: true })
  })

  const createStore = (
    overrides: Partial<{
      maxBytes: number
      lockTimeoutMs: number
      staleLockMs: number
      lockRetryMs: number
      operations: Partial<SecureJsonFileOperations>
    }> = {},
  ) =>
    new SecureJsonFileStore<TestShape>({
      filePath,
      validate: isTestShape,
      ...overrides,
    })

  it('requests private POSIX modes, fsyncs the replacement, and never chmods the shared parent', async () => {
    const opened: Array<{ filePath: string; flags: string | number; mode: number | undefined }> = []
    const handleChmods: Array<{ filePath: string; mode: number }> = []
    const syncs: string[] = []
    const mkdirs: Array<{ directoryPath: string; mode: number }> = []
    const pathsByDescriptor = new Map<number, string>()
    const privateDirectory = path.join(directoryPath, '.state.json.secure')

    const operations: Partial<SecureJsonFileOperations> = {
      platform: 'linux',
      mkdir: async (candidate, options) => {
        mkdirs.push({ directoryPath: candidate, mode: options.mode })
        return defaultSecureJsonFileOperations.mkdir(candidate, options)
      },
      open: async (candidate, flags, mode) => {
        opened.push({ filePath: candidate, flags, mode })
        const handle = await defaultSecureJsonFileOperations.open(candidate, flags, mode)
        pathsByDescriptor.set(handle.fd, candidate)
        return instrumentHandle(candidate, handle, {
          forceMode: candidate === privateDirectory ? 0o755 : undefined,
          handleChmods,
          skipChmod: true,
        })
      },
      fsync: async (fileDescriptor) => {
        const candidate = pathsByDescriptor.get(fileDescriptor) ?? `unknown:${fileDescriptor}`
        syncs.push(candidate)
        if (candidate !== directoryPath && candidate !== path.join(directoryPath, '.state.json.secure')) {
          await defaultSecureJsonFileOperations.fsync(fileDescriptor)
        }
      },
    }

    const store = createStore({ operations })
    await store.write({ saved: 1 })

    expect(mkdirs).toContainEqual({ directoryPath: privateDirectory, mode: 0o700 })
    expect(handleChmods).toContainEqual({ filePath: privateDirectory, mode: 0o700 })
    expect(handleChmods.some((call) => call.filePath === directoryPath)).toBe(false)

    expect(
      opened.some(
        (entry) => entry.filePath.includes('write.lock.choosing.') && entry.flags === 'wx' && entry.mode === 0o600,
      ),
    ).toBe(true)
    expect(
      opened.some(
        (entry) => entry.filePath.includes('write.lock.owner.') && entry.flags === 'wx' && entry.mode === 0o600,
      ),
    ).toBe(true)
    expect(
      opened.some((entry) => entry.filePath.endsWith('.tmp') && entry.flags === 'wx' && entry.mode === 0o600),
    ).toBe(true)
    expect(handleChmods.some((call) => call.filePath.includes('write.lock.') && call.mode === 0o600)).toBe(true)
    expect(syncs.some((candidate) => candidate.endsWith('.tmp'))).toBe(true)
    expect(syncs).toContain(directoryPath)
    await expect(store.read()).resolves.toEqual({ saved: 1 })
  })

  it('tightens a legacy target through its verified file descriptor', async () => {
    await fs.writeFile(filePath, JSON.stringify({ legacy: 1 }), { mode: 0o644 })
    const handleChmods: Array<{ filePath: string; mode: number }> = []
    const operations: Partial<SecureJsonFileOperations> = {
      platform: 'linux',
      open: async (candidate, flags, mode) => {
        const handle = await defaultSecureJsonFileOperations.open(candidate, flags, mode)
        return instrumentHandle(candidate, handle, {
          handleChmods,
          forceMode: candidate === filePath ? 0o644 : undefined,
        })
      },
    }

    await expect(createStore({ operations }).read()).resolves.toEqual({ legacy: 1 })
    expect(handleChmods).toContainEqual({ filePath, mode: 0o600 })
  })

  it('rejects symbolic links, non-regular targets, and hard links', async () => {
    const linkedDirectory = path.join(directoryPath, 'linked-directory')
    await fs.mkdir(linkedDirectory)
    await fs.symlink(linkedDirectory, filePath, 'junction')
    await expect(createStore().read()).rejects.toThrow(/non-regular/)

    await fs.unlink(filePath)
    await fs.mkdir(filePath)
    await expect(createStore().read()).rejects.toThrow(/non-regular/)

    await fs.rm(filePath, { recursive: true })
    await fs.writeFile(filePath, '{}')
    await fs.link(filePath, path.join(directoryPath, 'second-link.json'))
    await expect(createStore().read()).rejects.toThrow(/hard-linked/)
  })

  it('rejects oversized input and invalid top-level objects before use', async () => {
    await fs.writeFile(filePath, JSON.stringify({ oversized: 'x'.repeat(128) }))
    await expect(createStore({ maxBytes: 32 }).read()).rejects.toThrow(/32-byte limit/)

    await fs.writeFile(filePath, '[]')
    await expect(createStore().read()).rejects.toThrow(/invalid object shape/)

    await expect(createStore({ maxBytes: 32 }).write({ oversized: 12345678901234567890 })).rejects.toThrow(
      /32-byte limit/,
    )
  })

  it('uses exclusive temporary creation and cleans it when replacement fails', async () => {
    await createStore().write({ value: 0 })
    const opened: Array<{ filePath: string; flags: string | number }> = []
    const operations: Partial<SecureJsonFileOperations> = {
      open: async (candidate, flags, mode) => {
        opened.push({ filePath: candidate, flags })
        return defaultSecureJsonFileOperations.open(candidate, flags, mode)
      },
      rename: async (oldPath, newPath) => {
        if (newPath === filePath) {
          throw Object.assign(new Error('simulated replacement crash'), { code: 'EIO' })
        }
        await defaultSecureJsonFileOperations.rename(oldPath, newPath)
      },
    }

    await expect(createStore({ operations }).write({ value: 1 })).rejects.toThrow(/simulated replacement crash/)

    const privateDirectory = path.join(directoryPath, '.state.json.secure')
    expect(opened.some((entry) => entry.filePath.endsWith('.tmp') && entry.flags === 'wx')).toBe(true)
    expect((await fs.readdir(privateDirectory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    await expect(createStore().read()).resolves.toEqual({ value: 0 })
  })

  it('removes a crash-abandoned temporary artifact after acquiring the lock', async () => {
    const privateDirectory = path.join(directoryPath, '.state.json.secure')
    const abandonedPath = path.join(privateDirectory, 'state.json.abandoned.tmp')
    await fs.mkdir(privateDirectory, { recursive: true })
    await fs.writeFile(abandonedPath, 'partial')

    await createStore().write({ recovered: 1 })

    await expect(fs.stat(abandonedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(createStore().read()).resolves.toEqual({ recovered: 1 })
  })

  it('recovers an expired lock but bounds waiting for a live lock', async () => {
    const privateDirectory = path.join(directoryPath, '.state.json.secure')
    await fs.mkdir(privateDirectory, { recursive: true })
    const deadProcessId = 2_000_000_001
    const deadLockPath = path.join(privateDirectory, `write.lock.owner.1.${deadProcessId}.dead-owner`)
    await fs.writeFile(
      deadLockPath,
      JSON.stringify({
        v: 1,
        token: 'dead-owner',
        processId: deadProcessId,
        hostName: defaultSecureJsonFileOperations.hostName,
        createdAt: Date.now() - 60_000,
        ticket: 1,
      }),
    )
    const oldTime = new Date(Date.now() - 60_000)
    await fs.utimes(deadLockPath, oldTime, oldTime)

    await createStore({
      staleLockMs: 10,
      lockTimeoutMs: 500,
      operations: { isProcessAlive: (processId) => processId !== deadProcessId },
    }).write({ recovered: 1 })
    await expect(createStore().read()).resolves.toEqual({ recovered: 1 })

    const liveLockPath = path.join(
      privateDirectory,
      `write.lock.owner.1.${defaultSecureJsonFileOperations.processId}.live-owner`,
    )
    await fs.writeFile(
      liveLockPath,
      JSON.stringify({
        v: 1,
        token: 'live-owner',
        processId: defaultSecureJsonFileOperations.processId,
        hostName: defaultSecureJsonFileOperations.hostName,
        createdAt: Date.now() - 60_000,
        ticket: 1,
      }),
    )
    await fs.utimes(liveLockPath, oldTime, oldTime)
    await expect(
      createStore({ staleLockMs: 10, lockTimeoutMs: 25, lockRetryMs: 5 }).write({ blocked: 1 }),
    ).rejects.toThrow(/Timed out waiting/)
  })

  it('fails closed instead of deleting an unreadable stale artifact with ambiguous host ownership', async () => {
    const privateDirectory = path.join(directoryPath, '.state.json.secure')
    const ambiguousProcessId = 2_000_000_003
    const ambiguousPath = path.join(privateDirectory, `write.lock.owner.1.${ambiguousProcessId}.ambiguous-owner`)
    await fs.mkdir(privateDirectory, { recursive: true })
    await fs.writeFile(ambiguousPath, '{')
    const oldTime = new Date(Date.now() - 60_000)
    await fs.utimes(ambiguousPath, oldTime, oldTime)

    await expect(
      createStore({
        staleLockMs: 10,
        lockTimeoutMs: 25,
        lockRetryMs: 5,
        operations: { isProcessAlive: () => false },
      }).write({ unsafe: 1 }),
    ).rejects.toThrow(/Timed out waiting/)
    await expect(fs.stat(ambiguousPath)).resolves.toBeDefined()
  })

  it('never expires a live holder solely because its transaction exceeds the stale threshold', async () => {
    const first = createStore({ staleLockMs: 10, lockTimeoutMs: 500, lockRetryMs: 5 })
    const second = createStore({ staleLockMs: 10, lockTimeoutMs: 500, lockRetryMs: 5 })
    let releaseFirst!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let activeTransactions = 0
    let maximumActiveTransactions = 0

    const firstRun = first.runExclusive(async (transaction) => {
      activeTransactions += 1
      maximumActiveTransactions = Math.max(maximumActiveTransactions, activeTransactions)
      markEntered()
      try {
        await release
        await transaction.write({ first: 1 })
      } finally {
        activeTransactions -= 1
      }
    })
    await entered

    const secondRun = second.runExclusive(async (transaction) => {
      activeTransactions += 1
      maximumActiveTransactions = Math.max(maximumActiveTransactions, activeTransactions)
      try {
        await transaction.write({ ...(await transaction.read()), second: 2 })
      } finally {
        activeTransactions -= 1
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(activeTransactions).toBe(1)
    releaseFirst()
    await Promise.all([firstRun, secondRun])

    expect(maximumActiveTransactions).toBe(1)
    await expect(first.read()).resolves.toEqual({ first: 1, second: 2 })
  })

  it('orders contenders that choose the same ticket without overlapping', async () => {
    let arrivals = 0
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    const makeOperations = (): Partial<SecureJsonFileOperations> => {
      let readdirCalls = 0
      return {
        readdir: async (candidate) => {
          readdirCalls += 1
          const names = await defaultSecureJsonFileOperations.readdir(candidate)
          if (readdirCalls === 2) {
            arrivals += 1
            if (arrivals === 2) {
              releaseBarrier()
            }
            await barrier
          }
          return names
        },
      }
    }
    const first = createStore({ operations: makeOperations() })
    const second = createStore({ operations: makeOperations() })
    let activeTransactions = 0
    let maximumActiveTransactions = 0
    const run = (store: SecureJsonFileStore<TestShape>, key: string) =>
      store.update(async (current) => {
        activeTransactions += 1
        maximumActiveTransactions = Math.max(maximumActiveTransactions, activeTransactions)
        try {
          await new Promise((resolve) => setTimeout(resolve, 15))
          return { ...(current ?? {}), [key]: 1 }
        } finally {
          activeTransactions -= 1
        }
      })

    await Promise.all([run(first, 'first'), run(second, 'second')])

    expect(maximumActiveTransactions).toBe(1)
    await expect(first.read()).resolves.toEqual({ first: 1, second: 1 })
  })

  it('lets concurrent contenders recover one dead unique ticket without stealing either fresh owner', async () => {
    const privateDirectory = path.join(directoryPath, '.state.json.secure')
    const deadProcessId = 2_000_000_002
    const deadLockPath = path.join(privateDirectory, `write.lock.owner.1.${deadProcessId}.dead-race`)
    await fs.mkdir(privateDirectory, { recursive: true })
    await fs.writeFile(
      deadLockPath,
      JSON.stringify({
        v: 1,
        token: 'dead-race',
        processId: deadProcessId,
        hostName: defaultSecureJsonFileOperations.hostName,
        createdAt: Date.now() - 60_000,
        ticket: 1,
      }),
    )
    const oldTime = new Date(Date.now() - 60_000)
    await fs.utimes(deadLockPath, oldTime, oldTime)
    const operations = { isProcessAlive: (processId: number) => processId !== deadProcessId }
    const first = createStore({ staleLockMs: 10, operations })
    const second = createStore({ staleLockMs: 10, operations })

    await Promise.all([
      first.update((current) => ({ ...(current ?? {}), first: 1 })),
      second.update((current) => ({ ...(current ?? {}), second: 2 })),
    ])

    await expect(first.read()).resolves.toEqual({ first: 1, second: 2 })
  })

  it('rejects a private-directory identity swap before creating lock or temporary files', async () => {
    const privateDirectory = path.join(directoryPath, '.state.json.secure')
    const operations: Partial<SecureJsonFileOperations> = {
      platform: 'linux',
      lstat: async (candidate) => {
        const stats = await defaultSecureJsonFileOperations.lstat(candidate)
        if (candidate !== privateDirectory) {
          return stats
        }
        return new Proxy(stats, {
          get(target, property) {
            if (property === 'ino') {
              return 100
            }
            const value = Reflect.get(target, property, target) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          },
        }) as Stats
      },
      open: async (candidate, flags, mode) => {
        const handle = await defaultSecureJsonFileOperations.open(candidate, flags, mode)
        return instrumentHandle(candidate, handle, {
          forceInodeChange: candidate === privateDirectory,
          skipChmod: true,
        })
      },
    }

    await expect(createStore({ operations }).write({ blocked: 1 })).rejects.toThrow(/directory changed/)
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('propagates real directory fsync failures after replacement', async () => {
    const pathsByDescriptor = new Map<number, string>()
    const operations: Partial<SecureJsonFileOperations> = {
      open: async (candidate, flags, mode) => {
        const handle = await defaultSecureJsonFileOperations.open(candidate, flags, mode)
        pathsByDescriptor.set(handle.fd, candidate)
        return handle
      },
      fsync: async (fileDescriptor) => {
        if (pathsByDescriptor.get(fileDescriptor) === directoryPath) {
          throw Object.assign(new Error('directory durability failed'), { code: 'EIO' })
        }
        await defaultSecureJsonFileOperations.fsync(fileDescriptor)
      },
    }

    await expect(createStore({ operations }).write({ written: 1 })).rejects.toThrow(/directory durability failed/)
    await expect(createStore().read()).resolves.toEqual({ written: 1 })
  })

  it('serializes updates from separate instances without losing data', async () => {
    const first = createStore()
    const second = createStore()
    const updates = Array.from({ length: 40 }, (_, index) =>
      (index % 2 === 0 ? first : second).update((current) => ({
        ...(current ?? {}),
        [`key-${index}`]: index,
      })),
    )

    await Promise.all(updates)

    const stored = await first.read()
    expect(Object.keys(stored ?? {})).toHaveLength(40)
    for (let index = 0; index < 40; index += 1) {
      expect(stored?.[`key-${index}`]).toBe(index)
    }
  })
})

function instrumentHandle(
  filePath: string,
  handle: SecureJsonFileHandle,
  options: {
    handleChmods?: Array<{ filePath: string; mode: number }>
    forceMode?: number
    forceInodeChange?: boolean
    skipChmod?: boolean
  },
): SecureJsonFileHandle {
  return {
    fd: handle.fd,
    stat: async () => {
      const stats = await handle.stat()
      if (options.forceMode === undefined && !options.forceInodeChange) {
        return stats
      }
      return new Proxy(stats, {
        get(target, property) {
          if (property === 'mode' && options.forceMode !== undefined) {
            return (target.mode & ~0o777) | options.forceMode
          }
          if (property === 'ino' && options.forceInodeChange) {
            return target.ino + 1
          }
          const value = Reflect.get(target, property, target) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as Stats
    },
    read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
    writeFile: (data, encoding) => handle.writeFile(data, encoding),
    chmod: async (mode) => {
      options.handleChmods?.push({ filePath, mode })
      if (!options.skipChmod) {
        await handle.chmod(mode)
      }
    },
    close: () => handle.close(),
  }
}
