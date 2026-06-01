import { AnyFeatureDescription } from '@standardnotes/features'

import { User } from '../User/User'

export interface FeatureServiceInterface {
  getFeaturesForUser(user: User): Promise<Array<AnyFeatureDescription>>
  userIsEntitledToFeature(user: User, featureIdentifier: string): Promise<boolean>
  getFeaturesForOfflineUser(email: string): Promise<{ features: AnyFeatureDescription[]; roles: string[] }>
}
