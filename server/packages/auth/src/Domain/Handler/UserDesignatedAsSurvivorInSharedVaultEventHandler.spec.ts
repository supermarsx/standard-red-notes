import { UserDesignatedAsSurvivorInSharedVaultEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { DesignateSurvivor } from '../UseCase/DesignateSurvivor/DesignateSurvivor'

import { UserDesignatedAsSurvivorInSharedVaultEventHandler } from './UserDesignatedAsSurvivorInSharedVaultEventHandler'

describe('UserDesignatedAsSurvivorInSharedVaultEventHandler', () => {
  let designateSurvivor: DesignateSurvivor
  let logger: Logger

  const payload = {
    userUuid: '00000000-0000-0000-0000-000000000000',
    sharedVaultUuid: '11111111-1111-1111-1111-111111111111',
    timestamp: 123,
  }

  const event = { payload } as unknown as jest.Mocked<UserDesignatedAsSurvivorInSharedVaultEvent>

  const createHandler = () => new UserDesignatedAsSurvivorInSharedVaultEventHandler(designateSurvivor, logger)

  beforeEach(() => {
    designateSurvivor = {} as jest.Mocked<DesignateSurvivor>
    designateSurvivor.execute = jest.fn().mockResolvedValue(Result.ok('designated'))

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should designate the survivor for the shared vault', async () => {
    await createHandler().handle(event)

    expect(designateSurvivor.execute).toHaveBeenCalledWith({
      sharedVaultUuid: payload.sharedVaultUuid,
      userUuid: payload.userUuid,
      timestamp: payload.timestamp,
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log an error naming both uuids if designation fails', async () => {
    designateSurvivor.execute = jest.fn().mockResolvedValue(Result.fail('nope'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith(
      `Failed designate survivor for user ${payload.userUuid} and shared vault ${payload.sharedVaultUuid}: nope`,
    )
  })
})
