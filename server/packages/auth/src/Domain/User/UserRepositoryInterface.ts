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
  subscription?: 'active' | 'inactive' | 'none'
}

/**
 * Standard Red Notes: one row of the admin user list. `createdAt`/`updatedAt`
 * are ISO-8601 strings. `storageUsedBytes`/`storageLimitBytes` come from the
 * user's regular subscription settings (null when the user has no subscription
 * or the setting was never written; -1 limit means unlimited).
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
  mfaEnabled: boolean
  storageUsedBytes: number | null
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
  save(user: User): Promise<User>
  remove(user: User): Promise<User>
}
