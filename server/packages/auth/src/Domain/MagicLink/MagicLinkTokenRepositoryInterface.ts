import { MagicLinkToken } from './MagicLinkToken'

export interface MagicLinkTokenRepositoryInterface {
  findLatestByUserIdentifier(userIdentifier: string): Promise<MagicLinkToken | null>
  save(magicLinkToken: MagicLinkToken): Promise<void>
}
