import { ValueObject } from '../Core/ValueObject'
import { Result } from '../Core/Result'
import { RoleNameProps } from './RoleNameProps'

export class RoleName extends ValueObject<RoleNameProps> {
  static readonly NAMES = {
    CoreUser: 'CORE_USER',
    PlusUser: 'PLUS_USER',
    ProUser: 'PRO_USER',
    AdminUser: 'ADMIN_USER',
    VaultsUser: 'VAULTS_USER',
  }

  /**
   * DEPRECATED backward-compat alias. The admin role was historically named
   * 'INTERNAL_TEAM_USER' and was renamed to 'ADMIN_USER'. A short-lived
   * cross-service token issued by another service just before this deploy may
   * still carry the legacy string; `create` normalizes it to the canonical
   * ADMIN_USER value so such an in-flight token still authorizes admin.
   * Safe to remove once all issuers/tokens have rolled over.
   */
  private static readonly LEGACY_ALIASES: Record<string, string> = {
    INTERNAL_TEAM_USER: 'ADMIN_USER',
  }

  get value(): string {
    return this.props.value
  }

  hasMoreOrEqualPowerTo(roleName: RoleName): boolean {
    switch (this.value) {
      case RoleName.NAMES.AdminUser:
        return true
      case RoleName.NAMES.ProUser:
        return [RoleName.NAMES.CoreUser, RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser].includes(roleName.value)
      case RoleName.NAMES.PlusUser:
        return [RoleName.NAMES.CoreUser, RoleName.NAMES.PlusUser].includes(roleName.value)
      case RoleName.NAMES.VaultsUser:
        // Reflexive: VaultsUser has power >= itself. CoreUser and VaultsUser are
        // siblings (each only has power >= itself and, historically, VaultsUser
        // has been treated as >= CoreUser), so include both here.
        return [RoleName.NAMES.CoreUser, RoleName.NAMES.VaultsUser].includes(roleName.value)
      case RoleName.NAMES.CoreUser:
        return [RoleName.NAMES.CoreUser].includes(roleName.value)
      /*istanbul ignore next*/
      default:
        throw new Error(`Invalid role name: ${this.value}`)
    }
  }

  private constructor(props: RoleNameProps) {
    super(props)
  }

  static create(name: string): Result<RoleName> {
    // DEPRECATED: normalize any accepted legacy alias (e.g. the old
    // 'INTERNAL_TEAM_USER' admin role) to its canonical value before validating.
    const canonicalName = this.LEGACY_ALIASES[name] ?? name
    const isValidName = Object.values(this.NAMES).includes(canonicalName)
    if (!isValidName) {
      return Result.fail<RoleName>(`Invalid role name: ${name}`)
    } else {
      return Result.ok<RoleName>(new RoleName({ value: canonicalName }))
    }
  }
}
