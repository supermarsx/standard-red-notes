import { MigrationInterface, QueryRunner } from 'typeorm'

export class rbacGroups1719000000000 implements MigrationInterface {
  name = 'rbacGroups1719000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS "rbac_groups" ("uuid" varchar PRIMARY KEY NOT NULL, "name" varchar(255) NOT NULL, "description" varchar(1024), "created_at" bigint NOT NULL, "updated_at" bigint NOT NULL)',
    )
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "index_rbac_groups_on_name" ON "rbac_groups" ("name")')

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS "rbac_user_groups" ("group_uuid" varchar(36) NOT NULL, "user_uuid" varchar(36) NOT NULL, "created_at" bigint NOT NULL, PRIMARY KEY ("group_uuid", "user_uuid"))',
    )
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "index_rbac_user_groups_on_group_uuid" ON "rbac_user_groups" ("group_uuid")',
    )
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "index_rbac_user_groups_on_user_uuid" ON "rbac_user_groups" ("user_uuid")',
    )

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS "rbac_group_roles" ("group_uuid" varchar(36) NOT NULL, "role_name" varchar(255) NOT NULL, PRIMARY KEY ("group_uuid", "role_name"))',
    )
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "index_rbac_group_roles_on_group_uuid" ON "rbac_group_roles" ("group_uuid")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "index_rbac_group_roles_on_group_uuid"')
    await queryRunner.query('DROP TABLE "rbac_group_roles"')

    await queryRunner.query('DROP INDEX "index_rbac_user_groups_on_user_uuid"')
    await queryRunner.query('DROP INDEX "index_rbac_user_groups_on_group_uuid"')
    await queryRunner.query('DROP TABLE "rbac_user_groups"')

    await queryRunner.query('DROP INDEX "index_rbac_groups_on_name"')
    await queryRunner.query('DROP TABLE "rbac_groups"')
  }
}
