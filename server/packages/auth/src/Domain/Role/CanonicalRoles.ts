import { RoleName } from '@standardnotes/domain-core'

/**
 * Standard Red Notes: the DEFINITIVE role taxonomy surfaced to the admin panel.
 *
 * Exactly these FOUR roles are exposed as role cards and everywhere roles are
 * listed / assigned in admin. They MAP onto the existing RoleName enum + seeded
 * role rows — no enum change and no destructive migration:
 *
 *   - Admin user   -> INTERNAL_TEAM_USER (the admin / internal-team role)
 *   - Full user    -> PRO_USER           (the full-feature / pro tier)
 *   - Core user    -> CORE_USER          (the basic / standard tier)
 *   - Vaults user  -> VAULTS_USER        (the vault / collaboration role)
 *
 * PLUS_USER (and any legacy seeded role such as TRANSITION_USER) is deliberately
 * NOT exposed. It remains in the enum and the database so the subscription
 * mapping (RoleToSubscriptionMap: PlusPlan -> PLUS_USER) and any existing
 * user_roles rows are never broken — it is simply hidden from the admin surface.
 * Collapsing the enum/DB to exactly four would be a risky change (subscription
 * tier breakage + orphaned user_roles) and is intentionally avoided here.
 */
export interface CanonicalRoleDefinition {
  name: string
  label: string
}

export const CANONICAL_ADMIN_ROLES: CanonicalRoleDefinition[] = [
  { name: RoleName.NAMES.InternalTeamUser, label: 'Admin user' },
  { name: RoleName.NAMES.ProUser, label: 'Full user' },
  { name: RoleName.NAMES.CoreUser, label: 'Core user' },
  { name: RoleName.NAMES.VaultsUser, label: 'Vaults user' },
]

export const CANONICAL_ADMIN_ROLE_NAMES: string[] = CANONICAL_ADMIN_ROLES.map((role) => role.name)

const orderByName = new Map<string, number>(CANONICAL_ADMIN_ROLES.map((role, index) => [role.name, index]))
const labelByName = new Map<string, string>(CANONICAL_ADMIN_ROLES.map((role) => [role.name, role.label]))

export const isCanonicalAdminRole = (name: string): boolean => orderByName.has(name)

export const canonicalAdminRoleLabel = (name: string): string | null => labelByName.get(name) ?? null

export const canonicalAdminRoleOrder = (name: string): number =>
  orderByName.has(name) ? (orderByName.get(name) as number) : Number.MAX_SAFE_INTEGER
