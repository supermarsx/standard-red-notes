import { KeyParamsData } from '@standardnotes/responses'
import { Logger } from 'winston'
import { Username, Uuid } from '@standardnotes/domain-core'

import { KeyParamsFactoryInterface } from '../../User/KeyParamsFactoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { GetUserKeyParamsDTO } from './GetUserKeyParamsDTO'
import { GetUserKeyParamsResponse } from './GetUserKeyParamsResponse'
import { UseCaseInterface } from '../UseCaseInterface'
import { User } from '../../User/User'
import { PKCERepositoryInterface } from '../../User/PKCERepositoryInterface'
import { GetUserKeyParamsDTOV2Challenged } from './GetUserKeyParamsDTOV2Challenged'

export class GetUserKeyParams implements UseCaseInterface {
  constructor(
    private keyParamsFactory: KeyParamsFactoryInterface,
    private userRepository: UserRepositoryInterface,
    private pkceRepository: PKCERepositoryInterface,
    private logger: Logger,
    // Standard Red Notes: "multiple accounts per email" flag. Default OFF
    // (trailing optional param so existing call sites/specs are unchanged).
    private workspacesPerEmailEnabled = false,
  ) {}

  async execute(dto: GetUserKeyParamsDTO): Promise<GetUserKeyParamsResponse> {
    let user: User | null = null
    if (dto.email !== undefined) {
      const usernameOrError = Username.create(dto.email, { skipValidation: true })
      if (usernameOrError.isFailed()) {
        throw Error(usernameOrError.getError())
      }
      const username = usernameOrError.getValue()

      // Standard Red Notes: with the feature ON, the key-params lookup is keyed
      // by the composite (email, workspaceIdentifier). A non-matching pair falls
      // through to the same pseudo-params path as an unknown email below, so the
      // endpoint never reveals which (email, workspace) pairs exist beyond
      // today's email-existence behavior (enumeration parity). With the flag
      // OFF, the historical email-only lookup is used unchanged.
      if (this.workspacesPerEmailEnabled) {
        const workspaceIdentifier = this.normalizeWorkspaceIdentifier(dto.workspaceIdentifier)
        user = await this.userRepository.findOneByEmailAndWorkspaceIdentifier(username, workspaceIdentifier)
      } else {
        user = await this.userRepository.findOneByUsernameOrEmail(username)
      }
      if (!user) {
        this.logger.debug(`No user with email ${dto.email}. Creating pseudo key params.`)

        return {
          keyParams: this.keyParamsFactory.createPseudoParams(dto.email),
        }
      }
    } else if (dto.userUuid) {
      const userUuidOrError = Uuid.create(dto.userUuid)
      if (userUuidOrError.isFailed()) {
        throw Error(userUuidOrError.getError())
      }
      const userUuid = userUuidOrError.getValue()

      user = await this.userRepository.findOneByUuid(userUuid)
    }

    if (!user) {
      this.logger.debug('Could not find user with given parameters: %O', dto)

      throw Error('Could not find user')
    }

    this.logger.debug(`Creating key params for user ${user.email}. Authentication: ${dto.authenticated}`)

    const keyParams = await this.createKeyParams(dto, user, dto.authenticated)

    return {
      keyParams,
    }
  }

  private async createKeyParams(dto: GetUserKeyParamsDTO, user: User, authenticated: boolean): Promise<KeyParamsData> {
    if (this.isCodeChallengedVersion(dto)) {
      await this.pkceRepository.storeCodeChallenge(dto.codeChallenge)
    }

    return this.keyParamsFactory.create(user, authenticated)
  }

  private isCodeChallengedVersion(dto: GetUserKeyParamsDTO): dto is GetUserKeyParamsDTOV2Challenged {
    return (dto as GetUserKeyParamsDTOV2Challenged).codeChallenge !== undefined
  }

  /**
   * Standard Red Notes: collapses an absent/empty workspace name to the
   * reserved 'default' workspace (matches the DB column default and the Register
   * use case).
   */
  private normalizeWorkspaceIdentifier(requested?: string): string {
    const trimmed = (requested ?? '').trim()

    return trimmed.length === 0 ? 'default' : trimmed
  }
}
