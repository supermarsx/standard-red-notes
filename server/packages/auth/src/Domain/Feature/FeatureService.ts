import { RoleName } from '@standardnotes/domain-core'
import { AnyFeatureDescription, GetFeatures } from '@standardnotes/features'

import { FeatureServiceInterface } from './FeatureServiceInterface'
import { User } from '../User/User'

/**
 * Standard Red Notes: every user is unconditionally entitled to the full Pro
 * feature set. The legacy subscription/role-driven branch has been removed.
 */
export class FeatureService implements FeatureServiceInterface {
  async userIsEntitledToFeature(_user: User, _featureIdentifier: string): Promise<boolean> {
    return true
  }

  async getFeaturesForOfflineUser(_email: string): Promise<{ features: AnyFeatureDescription[]; roles: string[] }> {
    return {
      features: this.getIncludedFeatures(),
      roles: this.getIncludedRoles(),
    }
  }

  async getFeaturesForUser(_user: User): Promise<Array<AnyFeatureDescription>> {
    return this.getIncludedFeatures()
  }

  private getIncludedFeatures(): Array<AnyFeatureDescription> {
    return GetFeatures().map((feature) => ({
      ...feature,
      expires_at: undefined,
      no_expire: true,
      role_name: RoleName.NAMES.ProUser,
    })) as Array<AnyFeatureDescription>
  }

  private getIncludedRoles(): string[] {
    return [RoleName.NAMES.CoreUser, RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser, RoleName.NAMES.InternalTeamUser]
  }
}
