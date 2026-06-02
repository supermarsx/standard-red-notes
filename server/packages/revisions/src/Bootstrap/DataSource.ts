import { DataSource, EntityTarget, LoggerOptions, ObjectLiteral, Repository } from 'typeorm'

import { Env } from './Env'
import { SQLRevision } from '../Infra/TypeORM/SQL/SQLRevision'

import type { DataSourceOptions } from "typeorm";

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
      entities: [SQLRevision],
      migrations: [`${__dirname}/../../migrations/${migrationsSourceDirectoryName}/*.js`],
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

      const mySQLDataSourceOptions: Extract<DataSourceOptions, { type: "mysql" | "mariadb" }> = {
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
      }

      this._dataSource = new DataSource(mySQLDataSourceOptions)
    } else {
      const sqliteDataSourceOptions: Extract<DataSourceOptions, { type: "better-sqlite3" }> = {
        ...commonDataSourceOptions,
        type: "better-sqlite3",
        database: this.configuration.env.get('DB_SQLITE_DATABASE_PATH'),
        enableWAL: true,
      }

      this._dataSource = new DataSource(sqliteDataSourceOptions)
    }

    return this._dataSource
  }
}
