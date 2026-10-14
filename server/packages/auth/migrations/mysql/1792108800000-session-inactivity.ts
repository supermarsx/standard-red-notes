import { MigrationInterface, QueryRunner, Table } from 'typeorm'
export class sessionInactivity1792108800000 implements MigrationInterface {
  name = 'sessionInactivity1792108800000'
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'session_inactivity_policy',
        columns: [
          { name: 'id', type: 'int', isPrimary: true },
          { name: 'installed_at', type: 'bigint' },
        ],
      }),
    )
    await runner.manager
      .createQueryBuilder()
      .insert()
      .into('session_inactivity_policy')
      .values({ id: 1, installed_at: Date.now() })
      .execute()
    await runner.createTable(
      new Table({
        name: 'session_activity',
        columns: [
          { name: 'user_uuid', type: 'varchar', length: '36', isPrimary: true },
          { name: 'session_uuid', type: 'varchar', length: '36', isPrimary: true },
          { name: 'last_seen_at', type: 'bigint', isNullable: true },
          { name: 'revoked_at', type: 'bigint', isNullable: true },
        ],
      }),
    )
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('session_activity')
    await runner.dropTable('session_inactivity_policy')
  }
}
