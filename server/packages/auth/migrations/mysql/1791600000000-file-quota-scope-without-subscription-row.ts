import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: let `subscription_settings` hold a row for an account whose
 * subscription is SYNTHETIC.
 *
 * *** WHY THE FOREIGN KEY HAD TO GO, AND WHAT IT WAS ACTUALLY PROTECTING. ***
 *
 * `FILE_UPLOAD_BYTES_USED` and `FILE_UPLOAD_BYTES_LIMIT` are keyed on a
 * `user_subscriptions` uuid. On this fork the default entitlement mode is
 * `included`, under which `Register` never calls `ActivatePremiumFeatures` and NO
 * `user_subscriptions` row is ever written — while `GetUserSubscription`
 * synthesises a PRO_PLAN subscription for the client, whose uuid IS the user's own
 * uuid. So every account looked subscribed and had nowhere to keep a byte total:
 * the usage figure did not exist for anybody, on any default deployment, however
 * many files were uploaded.
 *
 * The fix stores that account's bookkeeping under the same synthetic identity the
 * client is already handed — the user's uuid — which this foreign key refused.
 * It is not a hypothetical refusal: with SQLite's `foreign_keys` pragma on, the
 * INSERT raised `FOREIGN KEY constraint failed`, the single-container event bus
 * is in-process and awaited, and the exception propagated back out of
 * `FinishUploadSession`, so **the upload itself failed with 400**. A constraint
 * that turns missing bookkeeping into a refused upload is worse than no
 * constraint.
 *
 * WHAT IS LOST: `ON DELETE CASCADE`, which could never fire.
 * `UserSubscriptionRepositoryInterface` has no delete method and nothing in this
 * tree issues a DELETE against `user_subscriptions` — subscriptions are cancelled
 * and expired, never removed — so the cascade has always been dead weight. A
 * settings row orphaned by a hand-deleted subscription is the same orphan this
 * schema already keeps for every user row that is deleted, and is read by nothing:
 * every reader looks settings up BY the subscription uuid it already holds.
 *
 * The drop is guarded on `information_schema` rather than issued blind, so this
 * runs cleanly on a database whose constraint is already absent (restored from a
 * dump, or created by a future consolidated schema).
 */
export class fileQuotaScopeWithoutSubscriptionRow1791600000000 implements MigrationInterface {
  name = 'fileQuotaScopeWithoutSubscriptionRow1791600000000'

  private readonly constraintName = 'FK_ad2907de2850d8b531ff23329f3'

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.constraintExists(queryRunner)) {
      await queryRunner.query(`ALTER TABLE \`subscription_settings\` DROP FOREIGN KEY \`${this.constraintName}\``)
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.constraintExists(queryRunner)) {
      return
    }

    // Reinstating the constraint would fail outright on any database that has
    // since recorded a total for an account with no subscription row, which is
    // every account on a default deployment. Those rows are deleted first so the
    // rollback is a rollback rather than a stuck migration: the totals are
    // bookkeeping, and `fix-quota` re-derives them from the files actually on
    // disk.
    await queryRunner.query(
      'DELETE FROM `subscription_settings` WHERE `user_subscription_uuid` NOT IN (SELECT `uuid` FROM `user_subscriptions`)',
    )
    await queryRunner.query(
      `ALTER TABLE \`subscription_settings\` ADD CONSTRAINT \`${this.constraintName}\` FOREIGN KEY (\`user_subscription_uuid\`) REFERENCES \`user_subscriptions\`(\`uuid\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    )
  }

  private async constraintExists(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(
      'SELECT COUNT(*) AS `total` FROM `information_schema`.`TABLE_CONSTRAINTS` ' +
        "WHERE `CONSTRAINT_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'subscription_settings' " +
        `AND \`CONSTRAINT_NAME\` = '${this.constraintName}' AND \`CONSTRAINT_TYPE\` = 'FOREIGN KEY'`,
    )) as Array<{ total: number | string }>

    return Number(rows[0]?.total ?? 0) > 0
  }
}
