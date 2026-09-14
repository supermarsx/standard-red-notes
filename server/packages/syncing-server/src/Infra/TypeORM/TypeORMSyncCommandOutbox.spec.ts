import 'reflect-metadata'
import { DataSource, getMetadataArgsStorage } from 'typeorm'

import { TypeORMSyncCommandOutbox, eventJsonColumnOptions, resolveEventJsonColumnType } from './TypeORMSyncCommandOutbox'

/**
 * `event_json` is `longtext` in the MySQL migration and `text` in SQLite; the
 * entity has to say the same thing as the migration on each driver (t90 N8)
 * without tripping TypeORM's per-driver column-type validation on SQLite.
 */
describe('TypeORMSyncCommandOutbox', () => {
  const originalDbType = process.env.DB_TYPE

  afterEach(() => {
    if (originalDbType === undefined) {
      delete process.env.DB_TYPE
    } else {
      process.env.DB_TYPE = originalDbType
    }
  })

  it('declares event_json as longtext on MySQL, matching the migration, and text elsewhere', () => {
    expect(resolveEventJsonColumnType('mysql')).toBe('longtext')
    expect(resolveEventJsonColumnType('sqlite')).toBe('text')
    expect(resolveEventJsonColumnType(undefined)).toBe('text')
  })

  it('resolves the column type when the metadata is built, not when the entity module was imported', () => {
    const registered = getMetadataArgsStorage().columns.find(
      (column) => column.target === TypeORMSyncCommandOutbox && column.propertyName === 'eventJson',
    )
    expect(registered?.options).toBe(eventJsonColumnOptions)

    process.env.DB_TYPE = 'mysql'
    expect(registered?.options.type).toBe('longtext')

    delete process.env.DB_TYPE
    expect(registered?.options.type).toBe('text')
  })

  it('builds MySQL entity metadata with a longtext event_json column', async () => {
    process.env.DB_TYPE = 'mysql'
    // Metadata only: nothing connects, but the validator insists on a database name.
    const dataSource = new DataSource({ type: 'mysql', database: 'syncing_server', entities: [TypeORMSyncCommandOutbox] })

    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas()

    expect(dataSource.getMetadata(TypeORMSyncCommandOutbox).findColumnWithPropertyName('eventJson')?.type).toBe(
      'longtext',
    )
  })

  it('initialises on SQLite, whose driver has no longtext type', async () => {
    delete process.env.DB_TYPE
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMSyncCommandOutbox],
      synchronize: true,
    })

    await dataSource.initialize()
    try {
      expect(dataSource.getMetadata(TypeORMSyncCommandOutbox).findColumnWithPropertyName('eventJson')?.type).toBe(
        'text',
      )
    } finally {
      await dataSource.destroy()
    }
  })
})
