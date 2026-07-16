import { Column, Entity, Index, JoinTable, ManyToMany, OneToMany, PrimaryGeneratedColumn } from 'typeorm'
import { RevokedSession } from '../Session/RevokedSession'
import { Role } from '../Role/Role'
import { ProtocolVersion } from '@standardnotes/common'
import { TypeORMEmergencyAccessInvitation } from '../../Infra/TypeORM/TypeORMEmergencyAccessInvitation'

/**
 * Standard Red Notes: the kinds of ban an admin can apply.
 *   - 'permanent': access is blocked indefinitely (the historical behavior; a
 *     legacy `banned=1` row with no explicit type is treated as permanent).
 *   - 'temporary': access is blocked only while `now < bannedUntil`; once the
 *     deadline passes the ban is inert and the user is treated as NOT banned.
 *   - 'shadow': the user CAN sign in and connect, but service is silently
 *     degraded downstream (reduced sync etc). Never disclosed to the user.
 */
export type BanType = 'temporary' | 'permanent' | 'shadow'

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
    nullable: true,
  })
  declare pwCost: number

  @Column({
    name: 'pw_key_size',
    type: 'int',
    nullable: true,
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
    nullable: true,
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
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  declare banReason: string | null

  /**
   * Standard Red Notes: the ban KIND ('temporary' | 'permanent' | 'shadow').
   * Nullable so legacy rows (and every non-banned user) leave it unset; an unset
   * value on a `banned=1` row is interpreted as 'permanent' (see
   * effectiveBanType), preserving the historical simple-ban behavior exactly.
   */
  @Column({
    name: 'ban_type',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  declare banType: BanType | null

  /**
   * Standard Red Notes: expiry for a 'temporary' ban. Once `now >= bannedUntil`
   * the ban is inert (the user is treated as not banned). Null for permanent /
   * shadow bans and for every non-banned user.
   */
  @Column({
    name: 'banned_until',
    type: 'datetime',
    nullable: true,
  })
  declare bannedUntil: Date | null

  /**
   * Standard Red Notes: reversible admin SUSPENSION — a neutral administrative
   * hold, first-class and SEPARATE from a ban. Defaults to false so existing
   * users are unaffected. A suspended user is hard-blocked from signing in and
   * any existing session/token is rejected (folded into isAccessBlocked), and
   * on suspend their sessions are additionally revoked for immediacy. Unsuspend
   * clears every suspension column; the user then signs in fresh.
   */
  @Column({
    name: 'suspended',
    type: 'tinyint',
    default: 0,
  })
  declare suspended: boolean

  @Column({
    name: 'suspended_at',
    type: 'datetime',
    nullable: true,
  })
  declare suspendedAt: Date | null

  @Column({
    name: 'suspended_reason',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  declare suspendedReason: string | null

  /**
   * Standard Red Notes: EMAIL CONFIRMATION. Defaults to TRUE at the database
   * level so that (a) existing rows backfilled by the migration and (b) every
   * new signup created while the feature is OFF are treated as confirmed — the
   * gate only ever affects NEW signups made while an admin has the feature ON,
   * for which Register explicitly sets this false. `emailConfirmedAt` records
   * when confirmation happened (null until confirmed).
   */
  @Column({
    name: 'email_confirmed',
    type: 'tinyint',
    default: 1,
  })
  declare emailConfirmed: boolean

  @Column({
    name: 'email_confirmed_at',
    type: 'datetime',
    nullable: true,
  })
  declare emailConfirmedAt: Date | null

  /**
   * Standard Red Notes: APPROVAL / WAITLIST QUEUE. Defaults to TRUE at the
   * database level so (a) existing rows backfilled by the migration and (b) every
   * new signup created while the feature is OFF are treated as approved — the
   * gate only affects NEW signups made while an admin has approvalRequired ON, for
   * which Register explicitly sets this false. A pending (approved=0) user is a
   * real user row whose ACCESS is gated (folded into isAccessBlocked), exactly
   * like suspension. `approvedAt` records when approval happened (null until then).
   */
  @Column({
    name: 'approved',
    type: 'tinyint',
    default: 1,
  })
  declare approved: boolean

  @Column({
    name: 'approved_at',
    type: 'datetime',
    nullable: true,
  })
  declare approvedAt: Date | null

  @Column({
    name: 'approval_note',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  declare approvalNote: string | null

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

  /**
   * Standard Red Notes: whether the account's email is confirmed. The column is
   * a tinyint(1): MySQL/MariaDB hydrate it as the NUMBER 0/1 while a freshly
   * built entity may carry a real boolean. A NULL/undefined value (e.g. a legacy
   * row read before the backfill, or an entity built without the column set) is
   * treated as confirmed so the gate can never lock out an account by accident.
   */
  isEmailConfirmed(): boolean {
    if (this.emailConfirmed === null || this.emailConfirmed === undefined) {
      return true
    }

    return Number(this.emailConfirmed) === 1
  }

  isPotentiallyAPrivateUsernameAccount(): boolean {
    return this.email.length === 64 && !this.email.includes('@')
  }

  /**
   * The EFFECTIVE ban kind, or null when the user carries no ban flag. A
   * `banned=1` row with no explicit `banType` is a legacy simple ban and reads
   * as 'permanent'. (Does NOT consider temporary expiry — see isBanned.)
   */
  effectiveBanType(): BanType | null {
    // The column is a tinyint(1): TypeORM hydrates it from MySQL/MariaDB as the
    // NUMBER 0/1, while SetUserBanStatus assigns a real boolean before saving.
    // A strict `=== true` comparison therefore reported every persisted ban as
    // "not banned" (numeric 1 !== true) and bans were silently never enforced.
    // Coerce so both representations count.
    if (Number(this.banned) !== 1) {
      return null
    }
    if (this.banType === 'temporary' || this.banType === 'shadow' || this.banType === 'permanent') {
      return this.banType
    }

    return 'permanent'
  }

  /**
   * True once a 'temporary' ban's deadline has passed — the ban is then inert.
   */
  private banHasExpired(now: Date): boolean {
    if (this.effectiveBanType() !== 'temporary' || this.bannedUntil === null || this.bannedUntil === undefined) {
      return false
    }

    return now.getTime() >= new Date(this.bannedUntil).getTime()
  }

  /**
   * Whether the user currently carries an ACTIVE ban of ANY kind (permanent,
   * shadow, or a not-yet-expired temporary ban). This is the reporting predicate
   * (admin panel / CLI / user list). Enforcement of ACCESS uses isAccessBlocked.
   */
  isBanned(now: Date = new Date()): boolean {
    if (Number(this.banned) !== 1) {
      return false
    }

    return !this.banHasExpired(now)
  }

  /**
   * Whether the user is actively SHADOW-banned: allowed to connect but degraded.
   */
  isShadowBanned(now: Date = new Date()): boolean {
    return this.isBanned(now) && this.effectiveBanType() === 'shadow'
  }

  /**
   * Standard Red Notes: whether the account is currently under an admin
   * SUSPENSION hold. The column is a tinyint(1): TypeORM hydrates it from
   * MySQL/MariaDB as the NUMBER 0/1 while SetUserSuspension assigns a real
   * boolean before saving, so coerce both representations (mirrors isBanned /
   * isEmailConfirmed — a strict `=== true` check would report every persisted
   * suspension as inactive and silently never enforce it).
   */
  isSuspended(): boolean {
    return Number(this.suspended) === 1
  }

  /**
   * Standard Red Notes: whether the account is APPROVED. The column is a
   * tinyint(1): TypeORM hydrates it as the NUMBER 0/1 while a freshly built entity
   * may carry a boolean. A NULL/undefined value (a legacy row read before the
   * backfill, or an entity built without the column set) is treated as approved so
   * the gate can never lock out an account by accident (mirrors isEmailConfirmed).
   */
  isApproved(): boolean {
    if (this.approved === null || this.approved === undefined) {
      return true
    }

    return Number(this.approved) === 1
  }

  /** Standard Red Notes: whether the account is awaiting administrator approval. */
  isPendingApproval(): boolean {
    return !this.isApproved()
  }

  /**
   * Whether access must be HARD-blocked (rejected at sign-in and on every
   * authenticated request): an active admin suspension, or an active permanent
   * or not-yet-expired temporary ban. A shadow ban is deliberately NOT
   * access-blocking — the shadow user connects and is degraded silently
   * instead. Suspension is unconditionally access-blocking (it has no shadow
   * variant), so folding it in here means BOTH existing gates (SignIn and
   * AuthenticateUser) reject a suspended user with zero new call sites.
   */
  isAccessBlocked(now: Date = new Date()): boolean {
    return (
      this.isPendingApproval() || this.isSuspended() || (this.isBanned(now) && this.effectiveBanType() !== 'shadow')
    )
  }
}
