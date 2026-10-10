import { Email, Username, Uuid } from '@standardnotes/domain-core'

import { ReadStream } from 'fs'
import { BanType, User } from './User'

/**
 * Standard Red Notes: sort key for the admin user-list finder. Direction is
 * fixed per key (date keys newest-first, email A→Z) so the API surface stays a
 * single `sort` param, mirroring the admin panel's needs.
 */
export type AdminUserSort = 'createdAt' | 'email' | 'updatedAt'

/**
 * Standard Red Notes: filters/pagination for the admin user-list finder. All
 * filters are optional and AND-combined. `createdAfter`/`createdBefore` are
 * epoch-ms. The finder never loads all users into memory: it runs a COUNT + a
 * LIMIT/OFFSET page query, then enriches only the returned page.
 */
export interface AdminUserListQuery {
  limit: number
  offset: number
  sort: AdminUserSort
  email?: string
  createdAfter?: number
  createdBefore?: number
  role?: string
  banned?: boolean
  // Standard Red Notes: filter by admin SUSPENSION state (a reversible hold,
  // separate from `banned`). Mirrors the `banned` filter.
  suspended?: boolean
  // Standard Red Notes: filter by APPROVAL state (false = the pending-approval
  // queue). Mirrors the `banned` filter.
  approved?: boolean
  subscription?: 'active' | 'inactive' | 'none'
}

/**
 * Standard Red Notes: one row of the admin user list. `createdAt`/`updatedAt`
 * are ISO-8601 strings.
 */
export interface AdminUserRow {
  uuid: string
  email: string
  createdAt: string
  updatedAt: string
  roles: string[]
  subscription: { plan: string | null; active: boolean } | null
  banned: boolean
  // Standard Red Notes: the effective ban KIND for an actively-banned row
  // ('temporary' | 'permanent' | 'shadow'), or null when not banned. Lets the
  // admin list render a per-row ban badge without a per-user round trip.
  banType: BanType | null
  // Standard Red Notes: whether the account is under an admin SUSPENSION hold
  // (reversible; separate from `banned`). Lets the admin list render a per-row
  // suspended badge without a per-user round trip.
  suspended: boolean
  // Standard Red Notes: whether the account is awaiting administrator approval
  // (approved=false). Lets the admin list render a per-row pending badge and
  // powers the pending-approvals queue.
  pendingApproval: boolean
  approvalNote: string | null
  mfaEnabled: boolean
  /**
   * Standard Red Notes: the account's uploaded-FILE byte total
   * (FILE_UPLOAD_BYTES_USED), read from the quota scope the writer uses — the
   * newest regular `user_subscriptions` row when the user has one, the user's own
   * uuid when it does not (see `loadStorageScopeByUser`, and
   * `ResolveFileQuotaScope` for why the second case is the normal one on a
   * self-hosted deployment).
   *
   * *** `null` IS NOT ZERO AND MUST NEVER BE RENDERED AS ONE. *** The counter is
   * written only when a FILE_UPLOADED event is handled, so an account whose
   * uploads have never succeeded has no row at all — "nobody measured this",
   * which is a different fact from "this account stores no files" and the one the
   * admin panel's storage column exists to keep apart.
   *
   * *** WHAT IS NOT IN IT. *** Synced ITEM payload (notes), which is the larger
   * half of most accounts. That figure is `items.content_size` on the syncing
   * server, exposed only self-scoped at `GET /v1/items/storage-usage`; no
   * endpoint anywhere publishes it for another user, so a LIST cannot carry it.
   * The field is file bytes and the column that prints it says so.
   */
  storageUsedBytes: number | null
  /**
   * Standard Red Notes: the account's explicit upload allowance
   * (FILE_UPLOAD_BYTES_LIMIT) from the same scope. `-1` means unlimited — the one
   * value the files server treats that way. `null` means no explicit allowance is
   * stored, so the plan default applies; that default is 0 for a plan whose role
   * grants no file-storage permission, so `null` is not an unlimited allowance.
   */
  storageLimitBytes: number | null
}

export interface AdminUserListResult {
  rows: AdminUserRow[]
  total: number
}

export interface UserRepositoryInterface {
  /**
   * Standard Red Notes: paginated + filtered user list for the admin panel.
   * Efficient by design — a COUNT and a single LIMIT/OFFSET page query, then a
   * fixed number of batched IN(...) enrichment queries for the page (roles,
   * subscription, MFA, storage) regardless of page size, so it stays bounded
   * even at the MAX 1500 page limit (never an N+1 per row).
   */
  findUsersForAdmin(query: AdminUserListQuery): Promise<AdminUserListResult>
  streamAll(): Promise<ReadStream>
  streamTeam(memberEmail?: Email): Promise<ReadStream>
  findOneByUuid(uuid: Uuid): Promise<User | null>
  findOneByUsernameOrEmail(usernameOrEmail: Email | Username): Promise<User | null>
  findAllByUsernameOrEmail(usernameOrEmail: Email | Username): Promise<User[]>
  /**
   * Standard Red Notes: resolves a single account by the composite
   * (email, workspace_identifier). Used only when WORKSPACES_PER_EMAIL_ENABLED
   * is ON to disambiguate which workspace an email maps to. With the flag OFF
   * this method is never called; callers use findOneByUsernameOrEmail as before.
   */
  findOneByEmailAndWorkspaceIdentifier(
    usernameOrEmail: Email | Username,
    workspaceIdentifier: string,
  ): Promise<User | null>
  findAllCreatedBetween(dto: { start: Date; end: Date; offset: number; limit: number }): Promise<User[]>
  countAllCreatedBetween(start: Date, end: Date): Promise<number>
  /**
   * Standard Red Notes: total number of user rows, for the GLOBAL
   * max-total-accounts cap. Mirrors countAllCreatedBetween with no WHERE.
   */
  countAll(): Promise<number>
  /**
   * Applies a conditional credential compare-and-swap and invalidates recovery
   * escrow in the same transaction. Returns null when the password hash or
   * protocol version changed since validation, so concurrent recovery attempts
   * cannot both win.
   */
  compareAndSwapCredentialsAndInvalidateAccountRecovery(dto: {
    user: User
    expectedEncryptedPassword: string
    expectedProtocolVersion: string | null
  }): Promise<User | null>
  save(user: User): Promise<User>
  remove(user: User): Promise<User>
}
