import { SyncCommandRepositoryInterface } from './SyncCommandRepositoryInterface'
import {
  SyncCommandMetadata,
  SyncCommandProtocolError,
  syncCommandDigestsEqual,
  validateSyncCommandMetadata,
} from './SyncCommandTypes'

export type SyncCommandStatusResult =
  | { command: { id: string; status: 'unknown' } }
  | {
      command: { id: string; digest: string; status: 'accepted' | 'committed' }
      result?: Record<string, unknown>
    }

export class GetSyncCommandStatus {
  constructor(private readonly commandRepository: SyncCommandRepositoryInterface) {}

  async execute(dto: {
    userUuid: string
    sessionUuid: string | null
    commandId: string
    requestDigest?: string
  }): Promise<SyncCommandStatusResult> {
    const validationDigest = dto.requestDigest ?? '0'.repeat(64)
    validateSyncCommandMetadata({ id: dto.commandId, digest: validationDigest })

    const command = await this.commandRepository.find(dto.userUuid, dto.sessionUuid ?? '', dto.commandId)
    if (!command) {
      return { command: { id: dto.commandId, status: 'unknown' } }
    }

    if (dto.requestDigest !== undefined) {
      const metadata: SyncCommandMetadata = { id: dto.commandId, digest: dto.requestDigest }
      validateSyncCommandMetadata(metadata)
      if (!syncCommandDigestsEqual(command.requestDigest, dto.requestDigest)) {
        throw new SyncCommandProtocolError(
          'sync_command_digest_mismatch',
          'Sync command id was already accepted with a different request digest.',
          409,
        )
      }
    }

    return {
      command: {
        id: command.commandId,
        digest: command.requestDigest,
        status: command.status,
      },
      result: command.status === 'committed' && command.responseJson ? JSON.parse(command.responseJson) : undefined,
    }
  }
}
