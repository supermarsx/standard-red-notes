import {
  FolderCreationCoordinator,
  FolderCreationFinalizationError,
  FolderMigrationCoordinator,
  MAX_FOLDER_PATH_DEPTH,
  MAX_INSERTS_PER_FOLDER_IDENTITY,
  folderCreationIdentity,
  folderCreationScope,
  folderInsertLimitKey,
  normalizeFolderName,
} from './FolderCreationCoordinator'

type Folder = { uuid: string; title: string }

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('FolderCreationCoordinator one-action/one-create contract', () => {
  it('coalesces double-click, observer reload, sync response, and fallback re-entry to one UUID', async () => {
    const coordinator = new FolderCreationCoordinator<Folder>()
    const sync = deferred<void>()
    const inserted: Folder[] = []
    const insert = jest.fn(async () => {
      const folder = { uuid: `folder-${inserted.length + 1}`, title: 'Projects' }
      inserted.push(folder)
      return folder
    })
    const finalize = jest.fn((_folder: Folder, _operationId: string) => sync.promise)
    const options = (operationId: string) => ({
      scope: folderCreationScope('account-a', 'vault-a'),
      identity: folderCreationIdentity([], 'Projects'),
      operationId,
      findExisting: () => inserted[0],
      create: insert,
      finalize,
    })

    const first = coordinator.createOnce(options('operation-first'))
    const doubleClick = coordinator.createOnce(options('operation-double-click'))
    await Promise.resolve()
    const observerReload = coordinator.createOnce(options('operation-observer'))
    const websocketFallbackReplay = coordinator.createOnce(options('operation-fallback'))

    expect(insert).toHaveBeenCalledTimes(1)
    expect(inserted.map((folder) => folder.uuid)).toEqual(['folder-1'])

    sync.resolve()
    await expect(Promise.all([first, doubleClick, observerReload, websocketFallbackReplay])).resolves.toEqual([
      inserted[0],
      inserted[0],
      inserted[0],
      inserted[0],
    ])
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith(inserted[0], 'operation-first')
  })

  it('coalesces a legacy migration and inline user create for the same scoped path', async () => {
    const coordinator = new FolderCreationCoordinator<Folder>()
    const finalize = deferred<void>()
    const insert = jest.fn(async () => ({ uuid: 'shared-folder', title: 'Projects' }))
    const base = {
      scope: folderCreationScope('account-a', 'vault-a'),
      identity: folderCreationIdentity(['Work'], 'Projects'),
      findExisting: () => undefined,
      create: insert,
      finalize: () => finalize.promise,
    }

    const migration = coordinator.createOnce({ ...base, operationId: 'migration-operation' })
    const inlineUserCreate = coordinator.createOnce({ ...base, operationId: 'inline-operation' })
    await Promise.resolve()

    expect(insert).toHaveBeenCalledTimes(1)
    finalize.resolve()
    await expect(Promise.all([migration, inlineUserCreate])).resolves.toEqual([
      expect.objectContaining({ uuid: 'shared-folder' }),
      expect.objectContaining({ uuid: 'shared-folder' }),
    ])
  })

  it('resolves an ambiguous response against the same inserted UUID and operation ID on reconnect', async () => {
    const coordinator = new FolderCreationCoordinator<Folder>()
    const inserted: Folder[] = []
    const insert = jest.fn(async () => {
      const folder = { uuid: `folder-${inserted.length + 1}`, title: 'Offline' }
      inserted.push(folder)
      return folder
    })
    const finalize = jest.fn(async () => {
      throw new FolderCreationFinalizationError('ambiguous', 'HTTP fallback failed after local insertion')
    })
    const resolveAmbiguous = jest.fn(async () => true)
    const options = (operationId: string) => ({
      scope: folderCreationScope('account-a', undefined),
      identity: folderCreationIdentity([], 'Offline'),
      operationId,
      findExisting: () => undefined,
      isCurrent: () => true,
      create: insert,
      finalize,
      resolveAmbiguous,
    })

    await expect(coordinator.createOnce(options('operation-offline'))).rejects.toThrow('HTTP fallback failed')
    await expect(coordinator.createOnce(options('operation-reconnect'))).resolves.toEqual(inserted[0])
    expect(insert).toHaveBeenCalledTimes(1)
    expect(inserted).toHaveLength(1)
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(resolveAmbiguous).toHaveBeenCalledWith(
      inserted[0],
      'operation-offline',
      expect.objectContaining({ outcome: 'ambiguous' }),
    )
  })

  it('retries a definitive finalization failure with the same UUID and operation ID', async () => {
    const coordinator = new FolderCreationCoordinator<Folder>()
    const folder = { uuid: 'folder-one', title: 'Projects' }
    const insert = jest.fn(async () => folder)
    const finalize = jest
      .fn<Promise<void>, [Folder, string]>()
      .mockRejectedValueOnce(new FolderCreationFinalizationError('definitive', 'local parent mutation failed'))
      .mockResolvedValueOnce(undefined)
    const options = (operationId: string) => ({
      scope: folderCreationScope('account-a', 'vault-a'),
      identity: folderCreationIdentity([], 'Projects'),
      operationId,
      findExisting: () => undefined,
      isCurrent: () => true,
      create: insert,
      finalize,
    })

    await expect(coordinator.createOnce(options('operation-original'))).rejects.toThrow('parent mutation failed')
    await expect(coordinator.createOnce(options('operation-retry-candidate'))).resolves.toBe(folder)

    expect(insert).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenNthCalledWith(1, folder, 'operation-original')
    expect(finalize).toHaveBeenNthCalledWith(2, folder, 'operation-original')
  })

  it('isolates a new action from a released pending scope and retires all scope metadata after settlement', async () => {
    const coordinator = new FolderCreationCoordinator<Folder>()
    const firstSync = deferred<void>()
    const scope = folderCreationScope('account-a', 'vault-a')
    let insertCount = 0
    const insert = jest.fn(async (): Promise<Folder> => {
      insertCount += 1
      return { uuid: `folder-${insertCount}`, title: 'Projects' }
    })
    const options = (operationId: string, finalize: () => Promise<void>) => ({
      scope,
      identity: folderCreationIdentity([], 'Projects'),
      operationId,
      findExisting: () => undefined,
      isCurrent: () => false,
      create: insert,
      finalize,
    })

    const pending = coordinator.createOnce(options('operation-before-release', () => firstSync.promise))
    await Promise.resolve()
    await Promise.resolve()
    coordinator.releaseScope(scope)

    // The released caller is still pending, but its old epoch cannot capture a
    // new action in the same account/vault/path scope.
    const replacement = coordinator.createOnce(options('operation-after-release', async () => undefined))
    await expect(replacement).resolves.toEqual(expect.objectContaining({ uuid: 'folder-2' }))
    expect(insert).toHaveBeenCalledTimes(2)

    firstSync.resolve()
    await expect(pending).resolves.toEqual(expect.objectContaining({ uuid: 'folder-1' }))

    coordinator.releaseScope(scope)
    expect(coordinator.retainedScopeCount()).toBe(0)
    expect(coordinator.retainedStateCount()).toBe(0)
  })

  it('keeps same-title folders under different parents/vaults and different names independent', async () => {
    const coordinator = new FolderCreationCoordinator<Folder>()
    const insert = jest
      .fn<Promise<Folder>, []>()
      .mockResolvedValueOnce({ uuid: 'a-projects', title: 'Projects' })
      .mockResolvedValueOnce({ uuid: 'a-archive', title: 'Archive' })
      .mockResolvedValueOnce({ uuid: 'b-projects', title: 'Projects' })
    const finalize = jest.fn(async () => undefined)
    const run = (scope: string, identity: string, operationId: string) =>
      coordinator.createOnce({
        scope,
        identity,
        operationId,
        findExisting: () => undefined,
        create: insert,
        finalize,
      })

    await expect(
      Promise.all([
        run(folderCreationScope('account-a', 'vault-a'), folderCreationIdentity(['Work'], 'Projects'), 'operation-1'),
        run(folderCreationScope('account-a', 'vault-a'), folderCreationIdentity(['Home'], 'Projects'), 'operation-2'),
        run(folderCreationScope('account-a', 'vault-b'), folderCreationIdentity(['Work'], 'Projects'), 'operation-3'),
      ]),
    ).resolves.toHaveLength(3)
    expect(insert).toHaveBeenCalledTimes(3)
    expect(finalize).toHaveBeenCalledTimes(3)
  })

  it('normalizes equivalent names and bounds nested parent creation', () => {
    expect(normalizeFolderName('  ProJects\t2026  ')).toEqual({
      display: 'ProJects 2026',
      identity: 'projects 2026',
    })
    expect(folderCreationIdentity([' Work '], 'Projects')).toBe(folderCreationIdentity(['work'], ' projects '))
    expect(() =>
      folderCreationIdentity(
        Array.from({ length: MAX_FOLDER_PATH_DEPTH }, () => 'parent'),
        'child',
      ),
    ).toThrow(/cannot exceed/)
  })
})

describe('FolderCreationCoordinator duplicate-insert ceiling', () => {
  /**
   * Reproduces the production failure: local item state never receives the created folder, so
   * `findExisting` and `isCurrent` both keep reporting it absent. Every attempt then looks like a
   * fresh user action creating the folder for the first time.
   */
  const brokenLocalStoreCoordinator = () => {
    const coordinator = new FolderCreationCoordinator<Folder>()
    const inserted: Folder[] = []
    const insert = jest.fn(async () => {
      const folder = { uuid: `folder-${inserted.length + 1}`, title: 'Projects' }
      inserted.push(folder)
      return folder
    })
    const options = (operationId: string) => ({
      scope: folderCreationScope('account-a', 'vault-a'),
      identity: folderCreationIdentity([], 'Projects'),
      operationId,
      findExisting: () => undefined,
      isCurrent: () => false,
      create: insert,
      finalize: async () => undefined,
    })
    return { coordinator, inserted, insert, options }
  }

  it('refuses to keep inserting when the created folder never lands in local item state', async () => {
    const { coordinator, insert, options } = brokenLocalStoreCoordinator()

    for (let attempt = 0; attempt < MAX_INSERTS_PER_FOLDER_IDENTITY; attempt += 1) {
      await coordinator.createOnce(options(`operation-${attempt}`))
    }
    expect(insert).toHaveBeenCalledTimes(MAX_INSERTS_PER_FOLDER_IDENTITY)

    await expect(coordinator.createOnce(options('operation-runaway'))).rejects.toThrow(
      /not present in local item state/,
    )
    await expect(coordinator.createOnce(options('operation-runaway-2'))).rejects.toThrow(
      /not present in local item state/,
    )
    expect(insert).toHaveBeenCalledTimes(MAX_INSERTS_PER_FOLDER_IDENTITY)
  })

  it('does not let scope retirement silently reset the ceiling', async () => {
    const { coordinator, insert, options } = brokenLocalStoreCoordinator()

    for (let attempt = 0; attempt < MAX_INSERTS_PER_FOLDER_IDENTITY + 2; attempt += 1) {
      await coordinator.createOnce(options(`operation-${attempt}`)).catch(() => undefined)
    }

    // Retiring the scope would mint a new generation and therefore a new key, which would restart
    // the count from zero and restore the unbounded write storm.
    expect(insert).toHaveBeenCalledTimes(MAX_INSERTS_PER_FOLDER_IDENTITY)
  })

  it('still allows recreating a folder the user genuinely deleted', async () => {
    const coordinator = new FolderCreationCoordinator<Folder>()
    const inserted: Folder[] = []
    let liveFolder: Folder | undefined
    const insert = jest.fn(async () => {
      const folder = { uuid: `folder-${inserted.length + 1}`, title: 'Projects' }
      inserted.push(folder)
      liveFolder = folder
      return folder
    })
    const options = (operationId: string) => ({
      scope: folderCreationScope('account-a', 'vault-a'),
      identity: folderCreationIdentity([], 'Projects'),
      operationId,
      findExisting: () => liveFolder,
      isCurrent: (folder: Folder) => liveFolder?.uuid === folder.uuid,
      create: insert,
      finalize: async () => undefined,
    })

    await coordinator.createOnce(options('operation-first'))
    expect(insert).toHaveBeenCalledTimes(1)

    // A healthy store: the delete is real, and the next create is a genuine new user action.
    liveFolder = undefined
    await coordinator.createOnce(options('operation-after-delete'))
    expect(insert).toHaveBeenCalledTimes(2)

    // An unchanged, present folder is still returned without inserting again.
    await coordinator.createOnce(options('operation-noop'))
    expect(insert).toHaveBeenCalledTimes(2)
  })

  it('still trips when a broken store makes the resolved identity differ each attempt', async () => {
    const coordinator = new FolderCreationCoordinator<Folder>()
    const inserted: Folder[] = []
    const insert = jest.fn(async () => {
      const folder = { uuid: `folder-${inserted.length + 1}`, title: 'Projects' }
      inserted.push(folder)
      return folder
    })

    /**
     * `folderCreationIdentity` takes an ancestor path resolved by walking local items. With those
     * ancestors missing the walk truncates differently from attempt to attempt, so identity — and
     * therefore the coalescing key — changes every time. Only a key that never consults local
     * state can recognise these as the same folder.
     */
    const ancestorPaths = [['Work', 'Clients'], ['Work'], [], ['Work', 'Clients'], ['Work']]
    const options = (attempt: number) => ({
      scope: folderCreationScope('account-a', 'vault-a'),
      identity: folderCreationIdentity(ancestorPaths[attempt], 'Projects'),
      insertLimitKey: folderInsertLimitKey('parent-uuid', 'Projects'),
      operationId: `operation-${attempt}`,
      findExisting: () => undefined,
      isCurrent: () => false,
      create: insert,
      finalize: async () => undefined,
    })

    for (let attempt = 0; attempt < ancestorPaths.length; attempt += 1) {
      await coordinator.createOnce(options(attempt)).catch(() => undefined)
    }

    expect(insert).toHaveBeenCalledTimes(MAX_INSERTS_PER_FOLDER_IDENTITY)
  })

  it('keys the ceiling per parent so different parents are not conflated', async () => {
    expect(folderInsertLimitKey('parent-a', 'Projects')).not.toBe(folderInsertLimitKey('parent-b', 'Projects'))
    expect(folderInsertLimitKey(undefined, 'Projects')).toBe(folderInsertLimitKey(undefined, '  projects  '))
  })

  it('resets the ceiling when the scope is released', async () => {
    const { coordinator, insert, options } = brokenLocalStoreCoordinator()
    const scope = folderCreationScope('account-a', 'vault-a')

    for (let attempt = 0; attempt < MAX_INSERTS_PER_FOLDER_IDENTITY + 1; attempt += 1) {
      await coordinator.createOnce(options(`operation-${attempt}`)).catch(() => undefined)
    }
    expect(insert).toHaveBeenCalledTimes(MAX_INSERTS_PER_FOLDER_IDENTITY)

    coordinator.releaseScope(scope)
    await coordinator.createOnce(options('operation-after-release'))

    expect(insert).toHaveBeenCalledTimes(MAX_INSERTS_PER_FOLDER_IDENTITY + 1)
  })
})

describe('FolderMigrationCoordinator', () => {
  it('blocks concurrent owners but releases ownership after failure for retry', async () => {
    const coordinator = new FolderMigrationCoordinator<object>()
    const owner = {}
    const pending = deferred<void>()
    const first = coordinator.run(owner, () => pending.promise)

    await expect(coordinator.run(owner, async () => undefined)).resolves.toBe(false)
    pending.reject(new Error('migration failed'))
    await expect(first).rejects.toThrow('migration failed')
    await expect(coordinator.run(owner, async () => undefined)).resolves.toBe(true)
  })
})
