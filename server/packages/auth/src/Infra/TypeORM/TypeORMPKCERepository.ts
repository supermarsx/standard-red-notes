import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'

import { PKCERepositoryInterface } from '../../Domain/User/PKCERepositoryInterface'
import { LoginGrantFlow, LoginGrantScope } from '../../Domain/User/LoginGrantScope'
import { User } from '../../Domain/User/User'

/** Verified account-scoped grants consumed by one atomic conditional SQL delete. */
export class TypeORMPKCERepository implements PKCERepositoryInterface {
  private readonly PREFIX = 'pkce'

  constructor(
    private cacheEntryRepository: CacheEntryRepositoryInterface,
    private logger: Logger,
    private timer: TimerInterface,
    private scope: LoginGrantScope,
  ) {}

  captureGrantScope(user: User, flow: LoginGrantFlow): Promise<string> {
    return this.scope.key('', user, flow)
  }

  async storeCodeChallenge(
    codeChallenge: string,
    user: User,
    flow: LoginGrantFlow,
    verifiedScope: string,
  ): Promise<void> {
    if (!verifiedScope || verifiedScope !== (await this.captureGrantScope(user, flow))) {
      throw new Error('Login factor policy changed during verification')
    }
    const scopedChallenge = `${verifiedScope}${codeChallenge}`

    await this.cacheEntryRepository.save(
      CacheEntry.create({
        key: this.keyFor(scopedChallenge),
        value: 'verified',
        expiresAt: this.timer.getUTCDateNSecondsAhead(3600),
      }).getValue(),
    )
    this.logger.debug('Stored verified login grant')
  }

  async removeCodeChallenge(codeChallenge: string, user: User, flow: LoginGrantFlow): Promise<boolean> {
    const key = this.keyFor(await this.scope.key(codeChallenge, user, flow))

    const consumed = await this.cacheEntryRepository.consumeUnexpiredByKey(key)
    this.logger.debug('Consumed verified login grant', { consumed })
    return consumed
  }

  private keyFor(codeChallenge: string): string {
    return `${this.PREFIX}:${codeChallenge}`
  }
}
