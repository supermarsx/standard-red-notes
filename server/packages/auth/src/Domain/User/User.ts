import { Column, Entity, Index, JoinTable, ManyToMany, OneToMany, PrimaryGeneratedColumn } from 'typeorm'
import { RevokedSession } from '../Session/RevokedSession'
import { Role } from '../Role/Role'
import { ProtocolVersion } from '@standardnotes/common'
import { TypeORMEmergencyAccessInvitation } from '../../Infra/TypeORM/TypeORMEmergencyAccessInvitation'

@Entity({ name: 'users' })
export class User {
  static readonly PASSWORD_HASH_COST = 11
  static readonly DEFAULT_ENCRYPTION_VERSION = 1

  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    length: 255,
    nullable: true,
  })
  declare version: string

  @Column({
    length: 255,
    nullable: true,
  })
  @Index('index_users_on_email')
  declare email: string

  /**
   * Standard Red Notes: workspace identifier for the "multiple accounts per
   * email" feature (env flag WORKSPACES_PER_EMAIL_ENABLED, default OFF).
   *
   * A workspace is an independent encrypted account that shares an email with
   * other workspaces. Account uniqueness becomes the composite
   * (email, workspace_identifier) instead of email alone.
   *
   * The column defaults to 'default' at the database level so that with the
   * flag OFF every account (and every legacy row) carries 'default' and the
   * composite unique index is exactly equivalent to the historical
   * one-account-per-email guarantee. When the flag is OFF this property is left
   * unset on freshly-built entities so the in-memory shape (and the persisted
   * row, via the DB default) is byte-for-byte identical to before.
   */
  @Column({
    name: 'workspace_identifier',
    length: 255,
    default: 'default',
  })
  declare workspaceIdentifier: string

  @Column({
    name: 'pw_nonce',
    length: 255,
    nullable: true,
  })
  declare pwNonce: string

  @Column({
    name: 'encrypted_server_key',
    length: 255,
    type: 'varchar',
    nullable: true,
  })
  declare encryptedServerKey: string | null

  @Column({
    name: 'server_encryption_version',
    type: 'tinyint',
    default: 0,
  })
  declare serverEncryptionVersion: number

  @Column({
    name: 'kp_created',
    length: 255,
    nullable: true,
  })
  declare kpCreated: string

  @Column({
    name: 'kp_origination',
    length: 255,
    nullable: true,
  })
  declare kpOrigination: string

  @Column({
    name: 'pw_cost',
    type: 'int',
    nullable: true
  })
  declare pwCost: number

  @Column({
    name: 'pw_key_size',
    type: 'int',
    nullable: true
  })
  declare pwKeySize: number

  @Column({
    name: 'pw_salt',
    length: 255,
    nullable: true,
  })
  declare pwSalt: string

  @Column({
    name: 'pw_alg',
    length: 255,
    nullable: true,
  })
  declare pwAlg: string

  @Column({
    name: 'pw_func',
    length: 255,
    nullable: true,
  })
  declare pwFunc: string

  @Column({
    name: 'encrypted_password',
    length: 255,
  })
  declare encryptedPassword: string

  @Column({
    name: 'created_at',
    type: 'datetime',
  })
  declare createdAt: Date

  @Column({
    name: 'updated_at',
    type: 'datetime',
  })
  declare updatedAt: Date

  @Column({
    name: 'locked_until',
    type: 'datetime',
    nullable: true,
  })
  declare lockedUntil: Date | null

  @Column({
    name: 'num_failed_attempts',
    type: 'int',
    nullable: true
  })
  declare numberOfFailedAttempts: number | null

  /**
   * Standard Red Notes: admin ban flag. Defaults to false so existing users are
   * unaffected. A banned user is blocked from signing in and any existing
   * session/token is rejected as unauthorized.
   */
  @Column({
    name: 'banned',
    type: 'tinyint',
    default: 0,
  })
  declare banned: boolean

  @Column({
    name: 'banned_at',
    type: 'datetime',
    nullable: true,
  })
  declare bannedAt: Date | null

  @Column({
    name: 'ban_reason',
    length: 255,
    nullable: true,
  })
  declare banReason: string | null

  @OneToMany(
    /* istanbul ignore next */
    () => RevokedSession,
    /* istanbul ignore next */
    (revokedSession) => revokedSession.user,
    /* istanbul ignore next */
    { lazy: true, eager: false },
  )
  declare revokedSessions: Promise<RevokedSession[]>

  @ManyToMany(
    /* istanbul ignore next */
    () => Role,
    /* istanbul ignore next */
    { lazy: true, eager: false },
  )
  @JoinTable({
    name: 'user_roles',
    joinColumn: {
      name: 'user_uuid',
      referencedColumnName: 'uuid',
    },
    inverseJoinColumn: {
      name: 'role_uuid',
      referencedColumnName: 'uuid',
    },
  })
  declare roles: Promise<Array<Role>>

  @OneToMany(
    /* istanbul ignore next */
    () => TypeORMEmergencyAccessInvitation,
    /* istanbul ignore next */
    (invitation) => invitation.grantor,
  )
  declare emergencyAccessInvitationsCreated: Promise<TypeORMEmergencyAccessInvitation[]>

  @OneToMany(
    /* istanbul ignore next */
    () => TypeORMEmergencyAccessInvitation,
    /* istanbul ignore next */
    (invitation) => invitation.grantee,
  )
  declare emergencyAccessInvitationsReceived: Promise<TypeORMEmergencyAccessInvitation[]>

  supportsSessions(): boolean {
    return parseInt(this.version) >= parseInt(ProtocolVersion.V004)
  }

  isPotentiallyAPrivateUsernameAccount(): boolean {
    return this.email.length === 64 && !this.email.includes('@')
  }

  isBanned(): boolean {
    return this.banned === true
  }
}
