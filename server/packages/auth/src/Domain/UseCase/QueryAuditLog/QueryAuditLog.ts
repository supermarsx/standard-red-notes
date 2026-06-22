import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { AuditLogRepositoryInterface } from '../../AuditLog/AuditLogRepositoryInterface'
import { AuditLogQuery } from '../../AuditLog/AuditLogQuery'

import { QueryAuditLogDTO } from './QueryAuditLogDTO'
import { QueryAuditLogResult } from './QueryAuditLogResult'

export class QueryAuditLog implements UseCaseInterface<QueryAuditLogResult> {
  private readonly DEFAULT_LIMIT = 50
  private readonly MAX_LIMIT = 200

  constructor(private auditLogRepository: AuditLogRepositoryInterface) {}

  async execute(dto: QueryAuditLogDTO): Promise<Result<QueryAuditLogResult>> {
    const limit = this.clamp(dto.limit ?? this.DEFAULT_LIMIT, 1, this.MAX_LIMIT)
    const offset = Math.max(0, dto.offset ?? 0)

    const query: AuditLogQuery = {
      limit,
      offset,
    }

    if (dto.actorUuid !== undefined && dto.actorUuid.length > 0) {
      query.actorUuid = dto.actorUuid
    }

    if (dto.action !== undefined && dto.action.length > 0) {
      query.action = dto.action
    }

    const createdAfter = this.parseDate(dto.from)
    if (createdAfter !== null) {
      query.createdAfter = createdAfter
    }

    const createdBefore = this.parseDate(dto.to)
    if (createdBefore !== null) {
      query.createdBefore = createdBefore
    }

    const { entries, total } = await this.auditLogRepository.find(query)

    return Result.ok({
      entries,
      total,
      limit,
      offset,
    })
  }

  private parseDate(value?: string): number | null {
    if (value === undefined || value.length === 0) {
      return null
    }

    const parsed = Date.parse(value)

    return Number.isNaN(parsed) ? null : parsed
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
  }
}
