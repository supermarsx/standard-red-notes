import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'mcp_tokens' })
export class TypeORMMcpToken {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_uuid',
    length: 36,
  })
  @Index('index_mcp_tokens_on_user_uuid')
  declare userUuid: string

  @Column({
    name: 'label',
    type: 'varchar',
    length: 255,
  })
  declare label: string

  @Column({
    name: 'hashed_token',
    type: 'varchar',
    length: 255,
  })
  declare hashedToken: string

  @Column({
    name: 'scope',
    type: 'varchar',
    length: 20,
  })
  declare scope: string

  @Column({
    name: 'scope_tag_uuids',
    type: 'text',
    nullable: true,
  })
  declare scopeTagUuids: string | null

  @Column({
    name: 'wrapped_keys',
    type: 'text',
  })
  declare wrappedKeys: string

  @Column({
    name: 'kdf_salt',
    type: 'varchar',
    length: 255,
  })
  declare kdfSalt: string

  @Column({
    name: 'kdf_params',
    type: 'text',
  })
  declare kdfParams: string

  @Column({
    name: 'created_at',
    type: 'bigint',
  })
  declare createdAt: number

  @Column({
    name: 'last_used_at',
    type: 'bigint',
    nullable: true,
  })
  declare lastUsedAt: number | null

  @Column({
    name: 'expires_at',
    type: 'bigint',
    nullable: true,
  })
  declare expiresAt: number | null
}
