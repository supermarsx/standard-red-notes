import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: widen `shares.encrypted_payload` so a share link can
 * actually carry the note it claims to share.
 *
 * A share link has no session, so an image a note embeds is unreachable from
 * the reader's browser: `GET /v1/files` and the valet-token mint both answer
 * 401 without one, and the file's key was never in the envelope. The fix is to
 * copy the images into the envelope at share-creation time (see the web
 * client's `Components/SharedView/shareAssets.ts`), which makes the ciphertext
 * as large as the note plus its images rather than the note alone.
 *
 * MySQL's `TEXT` holds 65,535 BYTES. That ceiling was already low for a long
 * Super note's Lexical JSON and is far below a single screenshot. Worse, the
 * failure is not loud: outside strict mode MySQL TRUNCATES an over-long TEXT
 * value and the row is written, so the share would be stored as a cut-off
 * ciphertext and every reader would be told the link is undecryptable — a
 * wrong-key message for a server-side truncation.
 *
 * `LONGTEXT` is the same storage family (no table rewrite semantics change, no
 * index touches this column), so this widens the ceiling without altering any
 * value already stored. The client caps a share's embedded images at 6 MiB of
 * decrypted bytes, ~8.4 MB base64, which stays inside both the server's default
 * 50 MB request limit and MariaDB's 16 MB `max_allowed_packet`.
 *
 * SQLite needs no twin: its `TEXT` affinity carries no declared length limit at
 * all (proved against a real in-memory database in
 * `src/Bootstrap/SharePayloadLongTextMigrations.spec.ts`, not asserted here).
 *
 * `down` returns the column to `text`. That is lossy by nature — any row longer
 * than 64 KiB cannot fit — which is exactly why `up` exists.
 */
export class sharePayloadLongText1791700000000 implements MigrationInterface {
  name = 'sharePayloadLongText1791700000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `shares` MODIFY `encrypted_payload` longtext NOT NULL')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `shares` MODIFY `encrypted_payload` text NOT NULL')
  }
}
