/**
 * Standard Red Notes: pure UI helpers for the Admin ROLES section (managing the
 * roles themselves — which permissions each role grants). Kept separate from
 * adminGroupsUi.ts (group<->role links) and adminHelpers.ts (owned elsewhere).
 *
 * Roles are enum + migration bound server-side: new role TYPES cannot be created
 * at runtime (they could never be assigned to a user or conferred by a group).
 * The only safe runtime edit is a role's permission ASSIGNMENTS, which is what
 * this section drives.
 */

export type AdminRole = {
  uuid: string
  name: string
  // Canonical human label ('Admin user', 'Full user', …). Optional so an older
  // server (that doesn't yet report it) still parses; falls back to `name`.
  label?: string
  version: number
  isBuiltIn: boolean
  // Optional so an older server (that doesn't yet report these) still parses.
  isCustom?: boolean
  description?: string | null
  permissionNames: string[]
}

/**
 * DEFINITIVE role taxonomy: the admin panel exposes exactly these four roles,
 * mapped onto the underlying RoleName enum. Mirrors the server's CanonicalRoles
 * so role names render with friendly labels everywhere they are listed.
 */
export const CANONICAL_ROLE_LABELS: Record<string, string> = {
  INTERNAL_TEAM_USER: 'Admin user',
  PRO_USER: 'Full user',
  CORE_USER: 'Core user',
  VAULTS_USER: 'Vaults user',
}

/** Friendly label for a role name; falls back to the raw name (e.g. legacy roles). */
export const canonicalRoleLabel = (name: string): string => CANONICAL_ROLE_LABELS[name] ?? name

/**
 * Canonical DEFAULT description per role, grounded in what each role actually
 * grants (the server's RoleName power hierarchy + seeded permissions). Mirrors
 * the server's CanonicalRoles descriptions and is used as the fallback when a
 * role has no DB description of its own (the built-in four). A custom role's own
 * description always wins — the server resolves that precedence before this map
 * is ever consulted.
 */
export const CANONICAL_ROLE_DESCRIPTIONS: Record<string, string> = {
  INTERNAL_TEAM_USER: 'Full administrative access — manage users, roles, groups, server settings, and every admin panel.',
  PRO_USER: 'Every end-user feature unlocked — notes, files, vaults, and the premium editors, at the highest tier.',
  CORE_USER: 'A standard account — core note-taking and sync with baseline limits.',
  VAULTS_USER: 'Collaboration-focused — shared vaults and team features on top of core note-taking.',
}

/**
 * Canonical default description for a role name; empty string for anything the
 * taxonomy doesn't know (e.g. legacy roles), so callers can render it directly
 * without printing a stray line. Mirrors canonicalRoleLabel().
 */
export const canonicalRoleDescription = (name: string): string => CANONICAL_ROLE_DESCRIPTIONS[name] ?? ''

/** One permission entry as returned by the catalog browser endpoint. */
export type PermissionCatalogEntry = {
  name: string
  category: string
  grantedByRoleNames: string[]
}

/** "Who has this role" summary from the role-holders inspector endpoint. */
export type RoleHolders = {
  uuid: string
  name: string
  directUserCount: number
  groups: Array<{ uuid: string; name: string }>
}

/** Result of the effective-permissions simulator (role-set resolver) endpoint. */
export type RoleSetResolution = {
  roleNames: string[]
  unknownRoleNames: string[]
  effectivePermissionNames: string[]
  perRole: Array<{ name: string; permissionNames: string[] }>
}

/**
 * Derive a permission's category from its name: the prefix before the first
 * ':' (e.g. 'server' for 'server:files'), or 'general' when it has none. Mirrors
 * the server's GetPermissionCatalog categorization so the client can group a
 * plain string[] catalog identically.
 */
export const permissionCategory = (permissionName: string): string => {
  const separatorIndex = permissionName.indexOf(':')
  if (separatorIndex > 0) {
    return permissionName.slice(0, separatorIndex)
  }

  return 'general'
}

/**
 * Human-friendly label for a permission name: drop the category prefix, then
 * Title-Case the remainder over both ':'/'_' separators. 'server:files_read'
 * -> 'Files Read'. Falls back to the whole name when there is no prefix.
 */
export const permissionLabel = (permissionName: string): string => {
  const separatorIndex = permissionName.indexOf(':')
  const remainder = separatorIndex > 0 ? permissionName.slice(separatorIndex + 1) : permissionName

  return remainder
    .split(/[:_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

/**
 * Group permission names by category, each group's members sorted, and the
 * groups returned in category order. Used by both the catalog browser and the
 * grouped per-role editor.
 */
export const groupPermissionsByCategory = (
  permissionNames: string[],
): Array<{ category: string; permissions: string[] }> => {
  const byCategory = new Map<string, string[]>()
  for (const name of permissionNames) {
    const category = permissionCategory(name)
    const bucket = byCategory.get(category) ?? []
    bucket.push(name)
    byCategory.set(category, bucket)
  }

  return Array.from(byCategory.entries())
    .map(([category, permissions]) => ({
      category,
      permissions: [...permissions].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category))
}

/**
 * Case-insensitive substring filter over permission names, matching either the
 * raw name or its human label so a search for "files" finds 'server:files'.
 * Empty/whitespace query returns the input unchanged.
 */
export const filterPermissionNames = (permissionNames: string[], query: string): string[] => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) {
    return permissionNames
  }

  return permissionNames.filter(
    (name) => name.toLowerCase().includes(needle) || permissionLabel(name).toLowerCase().includes(needle),
  )
}

/**
 * The set of role names a GROUP may confer, offered by the group role picker:
 * the built-in names the server reports as assignable, unioned with every role
 * the roles list reports (so admin-created CUSTOM roles are conferrable too).
 * Deduplicated, sorted, custom-or-unknown extras included.
 */
export const conferrableRoleNames = (availableRoleNames: string[], roles: AdminRole[]): string[] => {
  const names = new Set<string>(availableRoleNames)
  for (const role of roles) {
    names.add(role.name)
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b))
}

/**
 * Return `permissions` with `name` added (enabled) or removed (disabled).
 * Deduplicates, preserves order, appends on add. Never mutates the input.
 */
export const togglePermissionName = (current: string[], name: string, enabled: boolean): string[] => {
  if (enabled) {
    return current.includes(name) ? [...current] : [...current, name]
  }
  return current.filter((permission) => permission !== name)
}

/**
 * The full set of permission names to offer in a role's permission picker: every
 * permission in the server catalog, plus any permission the role already grants
 * that the catalog is missing (older server / partial catalog) — so an assigned
 * permission is never invisible or un-removable. Deduplicated; catalog order
 * first, unknown extras appended.
 */
export const permissionPickerOptions = (catalog: string[], assigned: string[]): string[] => {
  const options = [...new Set(catalog)]
  for (const permission of assigned) {
    if (!options.includes(permission)) {
      options.push(permission)
    }
  }
  return options
}

/**
 * Order-independent equality of two permission-name sets. Used to disable the
 * Save button while a role's draft matches what the server already has.
 */
export const permissionSetsEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) {
    return false
  }
  const setB = new Set(b)
  return a.every((permission) => setB.has(permission))
}
