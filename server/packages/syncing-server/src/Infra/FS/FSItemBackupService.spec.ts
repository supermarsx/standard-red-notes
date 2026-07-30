import { MapperInterface } from '@standardnotes/domain-core'
import { KeyParamsData } from '@standardnotes/responses'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Logger } from 'winston'

import { Item } from '../../Domain/Item/Item'
import { ItemBackupRepresentation } from '../../Mapping/Backup/ItemBackupRepresentation'
import { ItemHttpRepresentation } from '../../Mapping/Http/ItemHttpRepresentation'
import { FSItemBackupOperations, FSItemBackupService } from './FSItemBackupService'

describe('FSItemBackupService', () => {
  let uploadPath: string
  let backupMapper: MapperInterface<Item, ItemBackupRepresentation>
  let httpMapper: MapperInterface<Item, ItemHttpRepresentation>
  let logger: Logger

  const authParams = {
    identifier: 'person@example.com',
    pw_nonce: 'nonce',
    version: '004',
  } as KeyParamsData

  const item = (id: string) =>
    ({
      id: {
        toString: () => id,
      },
    }) as Item

  const projection = (id: string, content = `encrypted-${id}`): ItemHttpRepresentation => ({
    uuid: id,
    items_key_id: 'items-key-id',
    duplicate_of: null,
    enc_item_key: 'encrypted-item-key',
    content,
    content_type: 'Note',
    auth_hash: 'auth-hash',
    deleted: false,
    created_at: '2026-07-30T00:00:00.000Z',
    created_at_timestamp: 1,
    updated_at: '2026-07-30T00:00:01.000Z',
    updated_at_timestamp: 2,
    updated_with_session: null,
    key_system_identifier: null,
    shared_vault_uuid: null,
    user_uuid: '00000000-0000-0000-0000-000000000001',
    last_edited_by_uuid: null,
  })

  const openForTest = async (path: string, flags: 'wx', mode: number) => {
    const handle = await fs.open(path, flags, mode)

    return {
      writeFile: handle.writeFile.bind(handle),
      sync: async () => undefined,
      close: handle.close.bind(handle),
    } as Awaited<ReturnType<FSItemBackupOperations['open']>>
  }

  const testOperations = (overrides: Partial<FSItemBackupOperations> = {}): FSItemBackupOperations => ({
    mkdir: (path, options) => fs.mkdir(path, options),
    chmod: (path, mode) => fs.chmod(path, mode),
    open: openForTest,
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    rm: (path, options) => fs.rm(path, options),
    ...overrides,
  })

  const createService = (
    generateUuid: () => string = () => `generated-${Math.random().toString(36).slice(2)}`,
    operations: FSItemBackupOperations = testOperations(),
  ) => new FSItemBackupService(uploadPath, backupMapper, httpMapper, logger, generateUuid, operations)

  const readBackup = async (fileName: string) =>
    JSON.parse(await fs.readFile(join(uploadPath, 'backups', fileName), 'utf8')) as {
      items: ItemHttpRepresentation[]
      auth_params: KeyParamsData
    }

  beforeEach(async () => {
    uploadPath = await fs.mkdtemp(join(tmpdir(), 'srn-fs-item-backup-'))

    backupMapper = {} as jest.Mocked<MapperInterface<Item, ItemBackupRepresentation>>
    backupMapper.toProjection = jest.fn()

    httpMapper = {} as jest.Mocked<MapperInterface<Item, ItemHttpRepresentation>>
    httpMapper.toProjection = jest.fn().mockImplementation((value: Item) => projection(value.id.toString()))

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
  })

  afterEach(async () => {
    await fs.rm(uploadPath, { recursive: true, force: true })
  })

  it('writes Standard Notes-compatible items and auth_params through the HTTP mapper', async () => {
    const fileNames = await createService().backup([item('item-1'), item('item-2')], authParams)

    expect(fileNames).toHaveLength(1)
    await expect(readBackup(fileNames[0])).resolves.toEqual({
      items: [projection('item-1'), projection('item-2')],
      auth_params: authParams,
    })
    expect(httpMapper.toProjection).toHaveBeenCalledTimes(2)
    expect(backupMapper.toProjection).not.toHaveBeenCalled()
  })

  it('keeps completed backups readable across service restarts without overwriting them', async () => {
    const ids = ['first-backup', 'first-temp', 'second-backup', 'second-temp']
    const generateUuid = () => ids.shift() as string
    const firstService = createService(generateUuid)
    const [firstFileName] = await firstService.backup([item('item-1')], authParams)

    const restartedService = createService(generateUuid)
    const [secondFileName] = await restartedService.backup([item('item-2')], authParams)

    expect(firstFileName).not.toEqual(secondFileName)
    await expect(readBackup(firstFileName)).resolves.toEqual({
      items: [projection('item-1')],
      auth_params: authParams,
    })
    await expect(readBackup(secondFileName)).resolves.toEqual({
      items: [projection('item-2')],
      auth_params: authParams,
    })
  })

  it('bundles by complete UTF-8 backup JSON byte size', async () => {
    const firstProjection = projection('item-1', 'é'.repeat(20))
    const secondProjection = projection('item-2', 'encrypted-two')
    const thirdProjection = projection('item-3', 'encrypted-three')
    ;(httpMapper.toProjection as jest.Mock)
      .mockReturnValueOnce(firstProjection)
      .mockReturnValueOnce(secondProjection)
      .mockReturnValueOnce(thirdProjection)
    const twoItemLimit = Buffer.byteLength(
      JSON.stringify({ items: [firstProjection, secondProjection], auth_params: authParams }),
      'utf8',
    )

    const fileNames = await createService().backup(
      [item('item-1'), item('item-2'), item('item-3')],
      authParams,
      twoItemLimit,
    )
    const backups = await Promise.all(fileNames.map(readBackup))

    expect(backups.map((backup) => backup.items.map((value) => value.uuid))).toEqual([['item-1', 'item-2'], ['item-3']])
    for (const fileName of fileNames) {
      const contents = await fs.readFile(join(uploadPath, 'backups', fileName))
      expect(contents.byteLength).toBeLessThanOrEqual(twoItemLimit)
    }
  })

  it('writes one oversized item instead of emitting an empty file', async () => {
    const oversizedProjection = projection('oversized', 'x'.repeat(1_000))
    ;(httpMapper.toProjection as jest.Mock).mockReturnValueOnce(oversizedProjection)
    const singleItemSize = Buffer.byteLength(
      JSON.stringify({ items: [oversizedProjection], auth_params: authParams }),
      'utf8',
    )

    const fileNames = await createService().backup([item('oversized')], authParams, singleItemSize - 1)

    expect(fileNames).toHaveLength(1)
    await expect(readBackup(fileNames[0])).resolves.toEqual({
      items: [oversizedProjection],
      auth_params: authParams,
    })
    expect((await fs.readdir(join(uploadPath, 'backups'))).filter((name) => name.endsWith('.json'))).toHaveLength(1)
  })

  it('returns no files for an empty item set and rejects invalid limits', async () => {
    await expect(createService().backup([], authParams, 100)).resolves.toEqual([])
    await expect(createService().backup([item('item-1')], authParams, 0)).rejects.toThrow(
      'Backup content size limit must be a positive integer',
    )
    await expect(createService().backup([item('item-1')], authParams, Number.NaN)).rejects.toThrow(
      'Backup content size limit must be a positive integer',
    )
  })

  it('creates private backup directories and files', async () => {
    const mkdir = jest.fn((path: string, options: { recursive: true; mode: number }) => fs.mkdir(path, options))
    const chmod = jest.fn((path: string, mode: number) => fs.chmod(path, mode))
    const open = jest.fn(openForTest)
    const operations = testOperations({ mkdir, chmod, open })

    await createService(() => 'private-mode-id', operations).backup([item('item-1')], authParams)

    expect(mkdir).toHaveBeenCalledWith(join(uploadPath, 'backups'), { recursive: true, mode: 0o700 })
    expect(chmod).toHaveBeenCalledWith(join(uploadPath, 'backups'), 0o700)
    expect(open).toHaveBeenCalledWith(expect.stringContaining('.partial'), 'wx', 0o600)
  })

  it('removes the temporary file when atomic publication fails', async () => {
    const ids = ['backup-id', 'temp-id']
    const operations = testOperations({
      rename: async () => {
        throw new Error('simulated rename failure')
      },
    })

    await expect(
      createService(() => ids.shift() as string, operations).backup([item('item-1')], authParams),
    ).rejects.toThrow('simulated rename failure')

    await expect(fs.readdir(join(uploadPath, 'backups'))).resolves.toEqual([])
  })

  it('rejects generated paths that escape the dedicated backup directory', async () => {
    await expect(createService(() => '../escape').backup([item('item-1')], authParams)).rejects.toThrow(
      'Invalid backup path',
    )
    await expect(fs.stat(join(uploadPath, 'escape.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
