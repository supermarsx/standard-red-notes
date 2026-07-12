import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { AdminUserListResult, AdminUserSort, UserRepositoryInterface } from '../../User/UserRepositoryInterface'

/**
 * Standard Red Notes: the admin APPROVAL QUEUE — the paginated list of users
 * awaiting approval (approved=false). Delegates to the same efficient
 * findUsersForAdmin (COUNT + LIMIT/OFFSET + batched enrichment) with the
 * `approved:false` filter, so it never loads all users. Read-only.
 */
export class ListPendingUsers implements UseCaseInterface<AdminUserListResult> {
  constructor(private userRepository: UserRepositoryInterface) {}

  async execute(dto: { limit?: number; offset?: number; sort?: AdminUserSort }): Promise<Result<AdminUserListResult>> {
    const MAX_LIMIT = 1500
    let limit = dto.limit ?? 100
    if (!Number.isFinite(limit) || limit <= 0) {
      limit = 100
    }
    limit = Math.min(limit, MAX_LIMIT)

    let offset = dto.offset ?? 0
    if (!Number.isFinite(offset) || offset < 0) {
      offset = 0
    }

    const result = await this.userRepository.findUsersForAdmin({
      limit,
      offset,
      sort: dto.sort ?? 'createdAt',
      approved: false,
    })

    return Result.ok(result)
  }
}
