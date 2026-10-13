import { MigrationInterface, QueryRunner } from 'typeorm'
export class authSharedVaultReplicaLock1791936000001 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE auth_shared_vault_replica_lock (id integer NOT NULL PRIMARY KEY, generation bigint NOT NULL, full_generation bigint NOT NULL)',
    )
    await queryRunner.query(
      'INSERT INTO auth_shared_vault_replica_lock (id, generation, full_generation) VALUES (1, 0, 0)',
    )
    await queryRunner.query(
      'CREATE TABLE auth_shared_vault_replica_versions (user_uuid varchar(36) NOT NULL PRIMARY KEY, generation bigint NOT NULL)',
    )
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE auth_shared_vault_replica_lock')
    await queryRunner.query('DROP TABLE auth_shared_vault_replica_versions')
  }
}
