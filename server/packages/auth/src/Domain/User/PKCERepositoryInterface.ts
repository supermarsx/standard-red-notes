import { User } from './User'
import { LoginGrantFlow } from './LoginGrantScope'

export interface PKCERepositoryInterface {
  captureGrantScope(user: User, flow: LoginGrantFlow): Promise<string>
  storeCodeChallenge(codeChallenge: string, user: User, flow: LoginGrantFlow, verifiedScope: string): Promise<void>
  removeCodeChallenge(codeChallenge: string, user: User, flow: LoginGrantFlow): Promise<boolean>
}
