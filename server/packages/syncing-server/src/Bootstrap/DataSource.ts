import { DataSource, type DataSourceOptions, EntityTarget, LoggerOptions, ObjectLiteral, Repository } from 'typeorm'
import { Env } from './Env'
import { TypeORMNotification } from '../Infra/TypeORM/TypeORMNotification'
import { TypeORMSharedVault } from '../Infra/TypeORM/TypeORMSharedVault'
import { TypeORMSharedVaultUser } from '../Infra/TypeORM/TypeORMSharedVaultUser'
import { TypeORMSharedVaultInvite } from '../Infra/TypeORM/TypeORMSharedVaultInvite'
import { TypeORMMessage } from '../Infra/TypeORM/TypeORMMessage'
import { SQLItem } from '../Infra/TypeORM/SQLItem'
import { TypeORMSyncCommand } from '../Infra/TypeORM/TypeORMSyncCommand'
import { TypeORMSyncCommandOutbox } from '../Infra/TypeORM/TypeORMSyncCommandOutbox'

export class AppDataSource {
  private _dataSource: DataSource | undefined

  constructor(
    private configuration: {
      env: Env
      runMigrations: boolean
    },
  ) {}

  getRepository<Entity extends ObjectLiteral>(target: EntityTarget<Entity>): Repository<Entity> {
    if (!this._dataSource) {
      throw new Error('DataSource not initialized')
    }

    return this._dataSource.getRepository(target)
  }

  async initialize(): Promise<void> {
    await this.dataSource.initialize()
  }

  get dataSource(): DataSource {
    this.configuration.env.load()

    const isConfiguredForMySQL = this.configuration.env.get('DB_TYPE') === 'mysql'

    const maxQueryExecutionTime = this.configuration.env.get('DB_MAX_QUERY_EXECUTION_TIME', true)
      ? +this.configuration.env.get('DB_MAX_QUERY_EXECUTION_TIME', true)
      : 45_000

    const migrationsSourceDirectoryName = isConfiguredForMySQL ? 'mysql' : 'sqlite'

    const commonDataSourceOptions = {
      maxQueryExecutionTime,
      entities: [
        SQLItem,
        TypeORMNotification,
        TypeORMSharedVault,
        TypeORMSharedVaultUser,
        TypeORMSharedVaultInvite,
        TypeORMMessage,
        TypeORMSyncCommand,
        TypeORMSyncCommandOutbox,
      ],
      // SRN_MIGRATIONS_DIR override for the standalone server binary (see auth DataSource).
      migrations: [
        `${process.env.SRN_MIGRATIONS_DIR ?? __dirname + '/../../migrations'}/${migrationsSourceDirectoryName}/*.js`,
      ],
      migrationsRun: this.configuration.runMigrations,
      logging: (this.configuration.env.get('DB_DEBUG_LEVEL', true) as LoggerOptions) ?? 'info',
    }

    if (isConfiguredForMySQL) {
      const inReplicaMode = this.configuration.env.get('DB_REPLICA_HOST', true) ? true : false

      const replicationConfig = {
        master: {
          host: this.configuration.env.get('DB_HOST'),
          port: parseInt(this.configuration.env.get('DB_PORT')),
          username: this.configuration.env.get('DB_USERNAME'),
          password: this.configuration.env.get('DB_PASSWORD'),
          database: this.configuration.env.get('DB_DATABASE'),
        },
        slaves: [
          {
            host: this.configuration.env.get('DB_REPLICA_HOST', true),
            port: parseInt(this.configuration.env.get('DB_PORT')),
            username: this.configuration.env.get('DB_USERNAME'),
            password: this.configuration.env.get('DB_PASSWORD'),
            database: this.configuration.env.get('DB_DATABASE'),
          },
        ],
        removeNodeErrorCount: 10,
        restoreNodeTimeout: 5,
      }

      const mySQLDataSourceOptions: Extract<DataSourceOptions, { type: 'mysql' | 'mariadb' }> = {
        ...commonDataSourceOptions,
        type: 'mysql',
        charset: 'utf8mb4',
        supportBigNumbers: true,
        bigNumberStrings: false,
        replication: inReplicaMode ? replicationConfig : undefined,
        host: inReplicaMode ? undefined : this.configuration.env.get('DB_HOST'),
        port: inReplicaMode ? undefined : parseInt(this.configuration.env.get('DB_PORT')),
        username: inReplicaMode ? undefined : this.configuration.env.get('DB_USERNAME'),
        password: inReplicaMode ? undefined : this.configuration.env.get('DB_PASSWORD'),
        database: inReplicaMode ? undefined : this.configuration.env.get('DB_DATABASE'),
        // Standard Red Notes: sane, bounded connection pool (env-overridable) plus
        // TCP keep-alive + a connect timeout so a brief DB blip fails fast and the
        // pool self-heals dead sockets instead of the process wedging on a stalled
        // connection. Connection target/credentials are unchanged.
        poolSize: this.configuration.env.get('DB_CONNECTION_LIMIT', true)
          ? +this.configuration.env.get('DB_CONNECTION_LIMIT', true)
          : 20,
        extra: {
          waitForConnections: true,
          connectTimeout: 10_000,
          enableKeepAlive: true,
          keepAliveInitialDelay: 10_000,
        },
      }

      this._dataSource = new DataSource(mySQLDataSourceOptions)
    } else {
      const sqliteDataSourceOptions: Extract<DataSourceOptions, { type: 'better-sqlite3' }> = {
        ...commonDataSourceOptions,
        type: 'better-sqlite3',
        database: this.configuration.env.get('DB_SQLITE_DATABASE_PATH'),
        enableWAL: true,
      }

      this._dataSource = new DataSource(sqliteDataSourceOptions)
    }

    return this._dataSource
  }
}
