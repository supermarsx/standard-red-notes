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
  version: number
  isBuiltIn: boolean
  permissionNames: string[]
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
