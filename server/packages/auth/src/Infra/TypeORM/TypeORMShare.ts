import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'shares' })
export class TypeORMShare {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_uuid',
    length: 36,
  })
  @Index('index_shares_on_user_uuid')
  declare userUuid: string

  @Column({
    name: 'type',
    type: 'varchar',
    length: 20,
  })
  declare type: string

  /**
   * The PHYSICAL MySQL column is `longtext`, widened by migration
   * `1791700000000-share-payload-longtext`: a share link copies the note's
   * embedded images into the ciphertext (the reader has no session and so
   * cannot fetch them), and MySQL's 65,535-byte `TEXT` would TRUNCATE that
   * silently outside strict mode, storing a cut-off envelope that every reader
   * reads as a wrong key.
   *
   * This decorator deliberately still says `text`. TypeORM's SQLite driver does
   * not list `longtext` among its supported data types, so declaring it here
   * would make `EntityMetadataValidator` throw at DataSource initialisation —
   * the single container (sqlite) would fail to boot while every build and test
   * stayed green. The declared type affects schema generation only, which is
   * off here (`synchronize` is never enabled outside in-memory integration
   * specs), and reads/writes do not consult it. SQLite needs no widening at
   * all: its TEXT affinity carries no length limit.
   */
  @Column({
    name: 'encrypted_payload',
    type: 'text',
  })
  declare encryptedPayload: string

  @Column({
    name: 'nickname',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  declare nickname: string | null

  @Column({
    name: 'created_at',
    type: 'bigint',
  })
  declare createdAt: number

  @Column({
    name: 'revoked',
    type: 'boolean',
    default: false,
  })
  declare revoked: boolean

  @Column({
    name: 'one_time_view',
    type: 'boolean',
    default: false,
  })
  declare oneTimeView: boolean

  @Column({
    name: 'view_expires_minutes',
    type: 'integer',
    nullable: true,
  })
  declare viewExpiresMinutes: number | null

  @Column({
    name: 'first_opened_at',
    type: 'bigint',
    nullable: true,
  })
  declare firstOpenedAt: number | null
}
