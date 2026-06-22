import { MigrationInterface, QueryRunner } from 'typeorm'

export class rbacGroups1719000000000 implements MigrationInterface {
  name = 'rbacGroups1719000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `rbac_groups` (`uuid` varchar(36) NOT NULL, `name` varchar(255) NOT NULL, `description` varchar(1024) NULL, `created_at` bigint NOT NULL, `updated_at` bigint NOT NULL, UNIQUE INDEX `index_rbac_groups_on_name` (`name`), PRIMARY KEY (`uuid`)) ENGINE=InnoDB',
    )

    await queryRunner.query(
      'CREATE TABLE `rbac_user_groups` (`group_uuid` varchar(36) NOT NULL, `user_uuid` varchar(36) NOT NULL, `created_at` bigint NOT NULL, INDEX `index_rbac_user_groups_on_group_uuid` (`group_uuid`), INDEX `index_rbac_user_groups_on_user_uuid` (`user_uuid`), PRIMARY KEY (`group_uuid`, `user_uuid`)) ENGINE=InnoDB',
    )

    await queryRunner.query(
      'CREATE TABLE `rbac_group_roles` (`group_uuid` varchar(36) NOT NULL, `role_name` varchar(255) NOT NULL, INDEX `index_rbac_group_roles_on_group_uuid` (`group_uuid`), PRIMARY KEY (`group_uuid`, `role_name`)) ENGINE=InnoDB',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `index_rbac_group_roles_on_group_uuid` ON `rbac_group_roles`')
    await queryRunner.query('DROP TABLE `rbac_group_roles`')

    await queryRunner.query('DROP INDEX `index_rbac_user_groups_on_user_uuid` ON `rbac_user_groups`')
    await queryRunner.query('DROP INDEX `index_rbac_user_groups_on_group_uuid` ON `rbac_user_groups`')
    await queryRunner.query('DROP TABLE `rbac_user_groups`')

    await queryRunner.query('DROP INDEX `index_rbac_groups_on_name` ON `rbac_groups`')
    await queryRunner.query('DROP TABLE `rbac_groups`')
  }
}
