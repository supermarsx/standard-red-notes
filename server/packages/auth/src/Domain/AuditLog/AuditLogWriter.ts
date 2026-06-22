import { Logger } from 'winston'

import { AuditLogEntry } from './AuditLogEntry'
import { AuditLogRepositoryInterface } from './AuditLogRepositoryInterface'
import { AuditLogWriteParams, AuditLogWriterInterface } from './AuditLogWriterInterface'

/**
 * Standard Red Notes: best-effort audit-log writer. Persists a security-relevant
 * action. Never throws: a failed audit write is logged and swallowed so it can
 * never break the underlying action (login, settings change, etc.).
 */
export class AuditLogWriter implements AuditLogWriterInterface {
  constructor(
    private auditLogRepository: AuditLogRepositoryInterface,
    private logger: Logger,
  ) {}

  async write(params: AuditLogWriteParams): Promise<void> {
    try {
      const entryOrError = AuditLogEntry.create({
        actorUuid: params.actorUuid,
        action: params.action,
        targetType: params.targetType ?? null,
        targetUuid: params.targetUuid ?? null,
        ip: params.ip ?? null,
        metadata: params.metadata ?? null,
        createdAt: new Date(),
      })

      if (entryOrError.isFailed()) {
        this.logger.warn(`Could not build audit log entry for action ${params.action}: ${entryOrError.getError()}`)

        return
      }

      await this.auditLogRepository.save(entryOrError.getValue())
    } catch (error) {
      this.logger.error(`Could not write audit log entry for action ${params.action}: ${(error as Error).message}`)
    }
  }
}
