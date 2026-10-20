import * as IORedis from 'ioredis'
import { inject, injectable } from 'inversify'
import { Logger } from 'winston'

import TYPES from '../../Bootstrap/Types'
import { PKCERepositoryInterface } from '../../Domain/User/PKCERepositoryInterface'
import { LoginGrantFlow, LoginGrantScope } from '../../Domain/User/LoginGrantScope'
import { User } from '../../Domain/User/User'

@injectable()
export class RedisPKCERepository implements PKCERepositoryInterface {
  private readonly PREFIX = 'pkce'

  constructor(
    @inject(TYPES.Auth_Redis) private redisClient: IORedis.Redis,
    @inject(TYPES.Auth_Logger) private logger: Logger,
    @inject(LoginGrantScope) private scope: LoginGrantScope,
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
    const key = `${verifiedScope}${codeChallenge}`
    await this.redisClient.setex(`${this.PREFIX}:${key}`, 3600, 'verified')
    this.logger.debug('Stored verified login grant')
  }

  async removeCodeChallenge(codeChallenge: string, user: User, flow: LoginGrantFlow): Promise<boolean> {
    const key = await this.scope.key(codeChallenge, user, flow)
    const entriesRemoved = await this.redisClient.del(`${this.PREFIX}:${key}`)
    this.logger.debug('Consumed verified login grant', { consumed: entriesRemoved === 1 })

    return entriesRemoved === 1
  }
}
