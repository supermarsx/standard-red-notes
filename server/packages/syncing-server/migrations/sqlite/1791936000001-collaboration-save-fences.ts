import { MigrationInterface, QueryRunner, Table } from 'typeorm'

export class CollaborationSaveFences1791936000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'collaboration_save_fences',
        columns: [
          { name: 'room_uuid', type: 'varchar', length: '36', isPrimary: true },
          { name: 'owner_uuid', type: 'varchar', length: '128' },
          { name: 'owner_device_id', type: 'varchar', length: '128' },
          { name: 'lease_id', type: 'varchar', length: '128' },
          { name: 'room_epoch', type: 'varchar', length: '128' },
          { name: 'token', type: 'varchar', length: '64' },
          { name: 'expires_at', type: 'bigint' },
        ],
      }),
    )
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('collaboration_save_fences')
  }
}
