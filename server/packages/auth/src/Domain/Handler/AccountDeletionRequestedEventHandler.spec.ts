import { AccountDeletionRequestedEvent } from '@standardnotes/domain-events'
import { DeletedAccountMarkers, Uuid } from '@standardnotes/domain-core'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Logger } from 'winston'

import { EphemeralSessionRepositoryInterface } from '../Session/EphemeralSessionRepositoryInterface'
import { RevokedSessionRepositoryInterface } from '../Session/RevokedSessionRepositoryInterface'
import { SessionRepositoryInterface } from '../Session/SessionRepositoryInterface'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'

import { AccountDeletionRequestedEventHandler } from './AccountDeletionRequestedEventHandler'

describe('AccountDeletionRequestedEventHandler', () => {
  let userRepository: UserRepositoryInterface
  let sessionRepository: SessionRepositoryInterface
  let ephemeralSessionRepository: EphemeralSessionRepositoryInterface
  let revokedSessionRepository: RevokedSessionRepositoryInterface
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const user = { uuid: userUuid } as jest.Mocked<User>

  const session = { uuid: 'session-1' }
  const ephemeralSession = { uuid: 'ephemeral-1', userUuid }
  const revokedSession = { uuid: 'revoked-1' }

  const eventWith = (uuid: string) =>
    ({ payload: { userUuid: uuid } }) as unknown as jest.Mocked<AccountDeletionRequestedEvent>

  const createHandler = () =>
    new AccountDeletionRequestedEventHandler(
      userRepository,
      sessionRepository,
      ephemeralSessionRepository,
      revokedSessionRepository,
      logger,
    )

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(user)
    userRepository.remove = jest.fn().mockResolvedValue(undefined)

    sessionRepository = {} as jest.Mocked<SessionRepositoryInterface>
    sessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([session])
    sessionRepository.remove = jest.fn().mockResolvedValue(undefined)

    ephemeralSessionRepository = {} as jest.Mocked<EphemeralSessionRepositoryInterface>
    ephemeralSessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([ephemeralSession])
    ephemeralSessionRepository.deleteOne = jest.fn().mockResolvedValue(undefined)

    revokedSessionRepository = {} as jest.Mocked<RevokedSessionRepositoryInterface>
    revokedSessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([revokedSession])
    revokedSessionRepository.remove = jest.fn().mockResolvedValue(undefined)

    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
    logger.warn = jest.fn()
  })

  describe('recording the deletion for services that keep per-user data outside the database', () => {
    let root: string
    let directory: string
    const withMarkers = (markers: DeletedAccountMarkers) =>
      new AccountDeletionRequestedEventHandler(
        userRepository,
        sessionRepository,
        ephemeralSessionRepository,
        revokedSessionRepository,
        logger,
        markers,
      )

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-auth-markers-'))
      directory = path.join(root, 'deleted-accounts')
    })

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true })
    })

    it('writes a marker named by the account once the account has been removed', async () => {
      const order: string[] = []
      userRepository.remove = jest.fn().mockImplementation(async () => {
        // The marker says "this account is gone". It must not exist while the
        // account still does.
        order.push((await fs.readdir(root)).length === 0 ? 'removed-before-marker' : 'marker-before-removal')
      })

      await withMarkers(new DeletedAccountMarkers(directory)).handle(eventWith(userUuid))

      expect(order).toEqual(['removed-before-marker'])
      expect(await fs.readdir(directory)).toEqual([userUuid])
    })

    it('writes the marker for an account that is already gone, so a redelivered event still reaches other services', async () => {
      userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

      await withMarkers(new DeletedAccountMarkers(directory)).handle(eventWith(userUuid))

      expect(await fs.readdir(directory)).toEqual([userUuid])
      expect(userRepository.remove).not.toHaveBeenCalled()
    })

    it('writes nothing for a malformed id', async () => {
      await withMarkers(new DeletedAccountMarkers(directory)).handle(eventWith('not-a-uuid'))

      expect(await fs.readdir(root)).toEqual([])
    })

    it('writes nothing when the account could not be removed', async () => {
      userRepository.remove = jest.fn().mockRejectedValue(new Error('database is down'))

      await expect(withMarkers(new DeletedAccountMarkers(directory)).handle(eventWith(userUuid))).rejects.toThrow(
        'database is down',
      )
      expect(await fs.readdir(root)).toEqual([])
    })

    it('still deletes the account when the marker cannot be written, and says so', async () => {
      const blocked = path.join(root, 'a-file')
      await fs.writeFile(blocked, 'x')

      await withMarkers(new DeletedAccountMarkers(path.join(blocked, 'deleted-accounts'))).handle(eventWith(userUuid))

      expect(userRepository.remove).toHaveBeenCalledWith(user)
      expect(logger.warn).toHaveBeenCalledWith('Could not record the account deletion for other services.', {
        userId: userUuid,
      })
      expect(logger.info).toHaveBeenCalledWith('Finished account cleanup.', { userId: userUuid })
    })

    it('records nothing, and does not complain, where no shared location is configured', async () => {
      await withMarkers(new DeletedAccountMarkers(undefined)).handle(eventWith(userUuid))

      expect(userRepository.remove).toHaveBeenCalledWith(user)
      expect(logger.warn).not.toHaveBeenCalled()
      expect(await fs.readdir(root)).toEqual([])
    })
  })

  it('is the only code in the auth service that removes a user (a deletion added elsewhere would skip the record)', async () => {
    // A tripwire, not a proof: it reads the sources for calls that remove a
    // user through the repository. The record of a deletion is written here
    // because every deletion ends here; a second place that removes users
    // would delete accounts the api-gateway never hears about.
    const packageRoot = path.resolve(__dirname, '..', '..', '..')
    const callers: string[] = []
    for (const directory of ['src', 'bin']) {
      const entries = await fs.readdir(path.join(packageRoot, directory), { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
          continue
        }
        const file = path.join(entry.parentPath, entry.name)
        const code = (await fs.readFile(file, 'utf8'))
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join('\n')
        if (/\buserRepository\s*\.\s*remove\s*\(/i.test(code)) {
          callers.push(path.relative(packageRoot, file).split(path.sep).join('/'))
        }
      }
    }

    expect(callers).toEqual(['src/Domain/Handler/AccountDeletionRequestedEventHandler.ts'])
  })

  it('should do nothing if the user uuid in the event is malformed', async () => {
    await createHandler().handle(eventWith('not-a-uuid'))

    expect(userRepository.findOneByUuid).not.toHaveBeenCalled()
    expect(userRepository.remove).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('Could not find user.', { userId: 'not-a-uuid' })
  })

  it('should not remove any session if the user no longer exists', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(userUuid))

    expect(sessionRepository.findAllByUserUuid).not.toHaveBeenCalled()
    expect(userRepository.remove).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('Could not find user.', { userId: userUuid })
  })

  it('should purge every session type before removing the user', async () => {
    await createHandler().handle(eventWith(userUuid))

    const lookedUp = (userRepository.findOneByUuid as jest.Mock).mock.calls[0][0] as Uuid
    expect(lookedUp.value).toEqual(userUuid)

    expect(sessionRepository.findAllByUserUuid).toHaveBeenCalledWith(userUuid)
    expect(sessionRepository.remove).toHaveBeenCalledWith(session)
    expect(ephemeralSessionRepository.deleteOne).toHaveBeenCalledWith(ephemeralSession.uuid, ephemeralSession.userUuid)
    expect(revokedSessionRepository.remove).toHaveBeenCalledWith(revokedSession)

    expect(userRepository.remove).toHaveBeenCalledWith(user)
    expect(logger.info).toHaveBeenCalledWith('Finished account cleanup.', { userId: userUuid })
  })
})
