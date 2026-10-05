import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'magic_link_tokens' })
export class TypeORMMagicLinkToken {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_identifier',
    length: 255,
  })
  @Index('index_magic_link_tokens_on_user_identifier')
  declare userIdentifier: string

  @Column({
    name: 'code',
    type: 'varchar',
    length: 255,
  })
  declare code: string

  @Column({
    name: 'expires_at',
    type: 'datetime',
  })
  declare expiresAt: Date

  @Column({
    name: 'consumed',
    type: 'boolean',
    default: false,
  })
  declare consumed: boolean

  /**
   * Wrong guesses charged to THIS code. Lives on the token row rather than in a
   * second store so the per-code cap survives a restart and shares the token's
   * lifetime exactly. `NOT NULL DEFAULT 0` means every row that existed before the
   * column did starts with its full allowance rather than reading as exhausted.
   */
  @Column({
    name: 'failed_attempts',
    type: 'int',
    default: 0,
  })
  declare failedAttempts: number

  @Column({
    name: 'created_at',
    type: 'datetime',
  })
  declare createdAt: Date
}
