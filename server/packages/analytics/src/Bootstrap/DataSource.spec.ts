import 'reflect-metadata'

import { DataSource } from 'typeorm'

import { AnalyticsEntity } from '../Domain/Entity/AnalyticsEntity'
import { TypeORMRevenueModification } from '../Infra/TypeORM/TypeORMRevenueModification'

jest.mock('dotenv', () => ({
  config: jest.fn().mockReturnValue({ parsed: {} }),
}))

const BASE_ENV: Record<string, string> = {
  DB_HOST: 'db-host',
  DB_PORT: '3306',
  DB_USERNAME: 'analytics',
  DB_PASSWORD: 'secret',
  DB_DATABASE: 'analytics_db',
  DB_DEBUG_LEVEL: 'all',
}

const OPTIONAL_KEYS = ['DB_REPLICA_HOST', 'DB_MAX_QUERY_EXECUTION_TIME', 'DB_CONNECTION_LIMIT', 'DB_MIGRATIONS_PATH']

const loadAppDataSource = (extraEnv: Record<string, string> = {}): DataSource => {
  for (const key of OPTIONAL_KEYS) {
    delete process.env[key]
  }
  Object.assign(process.env, BASE_ENV, extraEnv)

  let dataSource: DataSource = null as unknown as DataSource
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    dataSource = require('./DataSource').AppDataSource
  })

  return dataSource
}

describe('AppDataSource', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('connects directly to the primary when no replica host is configured', () => {
    const options = loadAppDataSource().options as Record<string, unknown>

    expect(options.type).toEqual('mysql')
    expect(options.replication).toBeUndefined()
    expect(options.host).toEqual('db-host')
    expect(options.port).toEqual(3306)
    expect(options.username).toEqual('analytics')
    expect(options.password).toEqual('secret')
    expect(options.database).toEqual('analytics_db')
  })

  it('switches to a replicated connection when a replica host is configured', () => {
    const options = loadAppDataSource({ DB_REPLICA_HOST: 'replica-host' }).options as unknown as {
      host?: string
      port?: number
      username?: string
      password?: string
      database?: string
      replication: { master: Record<string, unknown>; slaves: Record<string, unknown>[] }
    }

    expect(options.host).toBeUndefined()
    expect(options.port).toBeUndefined()
    expect(options.username).toBeUndefined()
    expect(options.password).toBeUndefined()
    expect(options.database).toBeUndefined()
    expect(options.replication.master).toEqual({
      host: 'db-host',
      port: 3306,
      username: 'analytics',
      password: 'secret',
      database: 'analytics_db',
    })
    expect(options.replication.slaves).toEqual([
      {
        host: 'replica-host',
        port: 3306,
        username: 'analytics',
        password: 'secret',
        database: 'analytics_db',
      },
    ])
  })

  it('defaults the query timeout, pool size and migrations path when they are not configured', () => {
    const options = loadAppDataSource().options as Record<string, unknown>

    expect(options.maxQueryExecutionTime).toEqual(45_000)
    expect(options.poolSize).toEqual(20)
    expect(options.migrations).toEqual(['dist/migrations/*.js'])
  })

  it('takes the query timeout, pool size and migrations path from the environment', () => {
    const options = loadAppDataSource({
      DB_MAX_QUERY_EXECUTION_TIME: '1000',
      DB_CONNECTION_LIMIT: '5',
      DB_MIGRATIONS_PATH: 'build/migrations/*.js',
    }).options as Record<string, unknown>

    expect(options.maxQueryExecutionTime).toEqual(1000)
    expect(options.poolSize).toEqual(5)
    expect(options.migrations).toEqual(['build/migrations/*.js'])
  })

  it('registers both entities, runs migrations and takes the logging level from the environment', () => {
    const options = loadAppDataSource().options as Record<string, unknown>

    expect((options.entities as { name: string }[]).map((entity) => entity.name)).toEqual([
      AnalyticsEntity.name,
      TypeORMRevenueModification.name,
    ])
    expect(options.migrationsRun).toEqual(true)
    expect(options.logging).toEqual('all')
  })
})
