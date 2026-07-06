import { RoleName } from '@standardnotes/domain-core'

/**
 * Standard Red Notes: the DEFINITIVE role taxonomy surfaced to the admin panel.
 *
 * Exactly these FOUR roles are exposed as role cards and everywhere roles are
 * listed / assigned in admin. They MAP onto the existing RoleName enum + seeded
 * role rows — no enum change and no destructive migration:
 *
 *   - Admin user   -> ADMIN_USER          (the admin / internal-team role)
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
  /**
   * A concise, friendly one-liner describing what this role actually grants.
   * Grounded in the real entitlements: the RoleName power hierarchy
   * (hasMoreOrEqualPowerTo) and the seeded role_permissions —
   *   - AdminUser outranks every role (admin / full server control)
   *   - ProUser >= Core/Plus/Pro (every paid end-user feature + editors)
   *   - VaultsUser is a Core sibling with the shared-vault / collaboration grant
   *   - CoreUser is the baseline account (sync + core note-taking)
   * Used as the DEFAULT description for the built-in roles, whose DB
   * `description` column is null; a custom role's own DB description wins.
   */
  description: string
}

export const CANONICAL_ADMIN_ROLES: CanonicalRoleDefinition[] = [
  {
    name: RoleName.NAMES.AdminUser,
    label: 'Admin user',
    description:
      'Full administrative access — manage users, roles, groups, server settings, and every admin panel.',
  },
  {
    name: RoleName.NAMES.ProUser,
    label: 'Full user',
    description:
      'Every end-user feature unlocked — notes, files, vaults, and the premium editors, at the highest tier.',
  },
  {
    name: RoleName.NAMES.CoreUser,
    label: 'Core user',
    description: 'A standard account — core note-taking and sync with baseline limits.',
  },
  {
    name: RoleName.NAMES.VaultsUser,
    label: 'Vaults user',
    description: 'Collaboration-focused — shared vaults and team features on top of core note-taking.',
  },
]

export const CANONICAL_ADMIN_ROLE_NAMES: string[] = CANONICAL_ADMIN_ROLES.map((role) => role.name)

const orderByName = new Map<string, number>(CANONICAL_ADMIN_ROLES.map((role, index) => [role.name, index]))
const labelByName = new Map<string, string>(CANONICAL_ADMIN_ROLES.map((role) => [role.name, role.label]))
const descriptionByName = new Map<string, string>(CANONICAL_ADMIN_ROLES.map((role) => [role.name, role.description]))

export const isCanonicalAdminRole = (name: string): boolean => orderByName.has(name)

export const canonicalAdminRoleLabel = (name: string): string | null => labelByName.get(name) ?? null

export const canonicalAdminRoleDescription = (name: string): string | null => descriptionByName.get(name) ?? null

export const canonicalAdminRoleOrder = (name: string): number =>
  orderByName.has(name) ? (orderByName.get(name) as number) : Number.MAX_SAFE_INTEGER
