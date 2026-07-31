import { DomainEventHandlerInterface, UserDesignatedAsSurvivorInSharedVaultEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'
import { DesignateSurvivor } from '../UseCase/DesignateSurvivor/DesignateSurvivor'

export class UserDesignatedAsSurvivorInSharedVaultEventHandler implements DomainEventHandlerInterface {
  constructor(
    private designateSurvivorUseCase: DesignateSurvivor,
    private logger: Logger,
  ) {}

  async handle(event: UserDesignatedAsSurvivorInSharedVaultEvent): Promise<void> {
    const result = await this.designateSurvivorUseCase.execute({
      sharedVaultUuid: event.payload.sharedVaultUuid,
      userUuid: event.payload.userUuid,
      timestamp: event.payload.timestamp,
    })

    if (result.isFailed()) {
      this.logger.error('Failed to designate a survivor for a shared vault.', {
        userId: event.payload.userUuid,
        sharedVaultId: event.payload.sharedVaultUuid,
      })
    }
  }
}
