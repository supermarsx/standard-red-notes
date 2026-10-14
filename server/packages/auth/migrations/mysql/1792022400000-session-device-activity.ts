import { MigrationInterface, QueryRunner, Table } from 'typeorm'

export class sessionDeviceActivity1792022400000 implements MigrationInterface {
  name = 'sessionDeviceActivity1792022400000'
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'session_device_activity',
        columns: [
          { name: 'user_uuid', type: 'varchar', length: '36', isPrimary: true },
          { name: 'session_uuid', type: 'varchar', length: '36', isPrimary: true },
          { name: 'device_id', type: 'varchar', length: '128', isPrimary: true },
          { name: 'last_seen_at', type: 'bigint' },
        ],
      }),
    )
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('session_device_activity')
  }
}
