import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm'
export class authSessionGeneration1792022400001 implements MigrationInterface {
  name = 'authSessionGeneration1792022400001'
  async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['users', 'sessions'])
      await queryRunner.addColumn(table, new TableColumn({ name: 'auth_generation', type: 'int', default: 0 }))
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['sessions', 'users']) await queryRunner.dropColumn(table, 'auth_generation')
  }
}
