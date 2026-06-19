import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddEditedByUuid1750000000000 implements MigrationInterface {
  name = 'AddEditedByUuid1750000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "revisions_revisions" ADD "edited_by_uuid" varchar(36)')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "revisions_revisions" DROP COLUMN "edited_by_uuid"')
  }
}
