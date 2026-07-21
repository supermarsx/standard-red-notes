import { ExtensionKeyGrantedEvent } from '@standardnotes/domain-events'
import { Result, SettingName } from '@standardnotes/domain-core'
import { ContentDecoderInterface } from '@standardnotes/common'
import { Logger } from 'winston'

import { OfflineSettingName } from '../Setting/OfflineSettingName'
import { OfflineSettingServiceInterface } from '../Setting/OfflineSettingServiceInterface'
import { SetSettingValue } from '../UseCase/SetSettingValue/SetSettingValue'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'

import { ExtensionKeyGrantedEventHandler } from './ExtensionKeyGrantedEventHandler'

describe('ExtensionKeyGrantedEventHandler', () => {
  let userRepository: UserRepositoryInterface
  let setSettingValue: SetSettingValue
  let offlineSettingService: OfflineSettingServiceInterface
  let contentDecoder: ContentDecoderInterface
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const userEmail = 'user@example.com'
  const user = { uuid: userUuid, email: userEmail } as jest.Mocked<User>

  const eventWith = (payload: Record<string, unknown>) =>
    ({ payload }) as unknown as jest.Mocked<ExtensionKeyGrantedEvent>

  const createHandler = () =>
    new ExtensionKeyGrantedEventHandler(userRepository, setSettingValue, offlineSettingService, contentDecoder, logger)

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(user)

    setSettingValue = {} as jest.Mocked<SetSettingValue>
    setSettingValue.execute = jest.fn().mockResolvedValue(Result.ok('set'))

    offlineSettingService = {} as jest.Mocked<OfflineSettingServiceInterface>
    offlineSettingService.createOrUpdate = jest.fn().mockResolvedValue(undefined)

    contentDecoder = {} as jest.Mocked<ContentDecoderInterface>
    contentDecoder.decode = jest.fn().mockReturnValue({ extensionKey: 'decoded-key' })

    logger = {} as jest.Mocked<Logger>
    logger.warn = jest.fn()
    logger.error = jest.fn()
  })

  it('should do nothing if the user email is not a valid username', async () => {
    await createHandler().handle(eventWith({ userEmail: '', extensionKey: 'key' }))

    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('should store the decoded offline features token for an offline grant', async () => {
    await createHandler().handle(eventWith({ userEmail, offline: true, offlineFeaturesToken: 'raw-token' }))

    expect(contentDecoder.decode).toHaveBeenCalledWith('raw-token', 0)
    expect(offlineSettingService.createOrUpdate).toHaveBeenCalledWith({
      email: userEmail,
      name: OfflineSettingName.FeaturesToken,
      value: 'decoded-key',
    })
    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
  })

  it('should not store an offline setting when the features token has no extension key', async () => {
    contentDecoder.decode = jest.fn().mockReturnValue({})

    await createHandler().handle(eventWith({ userEmail, offline: true, offlineFeaturesToken: 'raw-token' }))

    expect(offlineSettingService.createOrUpdate).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('Could not decode offline features token')
  })

  it('should warn and do nothing if the online user cannot be found', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith({ userEmail, extensionKey: 'key' }))

    expect(setSettingValue.execute).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(`Could not find user with email: ${userEmail}`)
  })

  it('should set the extension key setting for an online user', async () => {
    await createHandler().handle(eventWith({ userEmail, extensionKey: 'granted-key' }))

    expect(setSettingValue.execute).toHaveBeenCalledWith({
      userUuid,
      settingName: SettingName.NAMES.ExtensionKey,
      value: 'granted-key',
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log an error if the extension key setting could not be stored', async () => {
    setSettingValue.execute = jest.fn().mockResolvedValue(Result.fail('nope'))

    await createHandler().handle(eventWith({ userEmail, extensionKey: 'granted-key' }))

    expect(logger.error).toHaveBeenCalledWith(`Could not set extension key for user ${userUuid}`)
  })
})
