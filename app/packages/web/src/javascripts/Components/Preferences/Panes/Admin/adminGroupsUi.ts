/**
 * Standard Red Notes: pure UI helpers for the Admin Groups & roles tab. Lives
 * in its own file — adminHelpers.ts is owned by a concurrent change and must
 * stay untouched.
 */

/**
 * Return the group's role list with `roleName` added (enabled) or removed
 * (disabled). Deduplicates and preserves the existing order; adding appends.
 * Never mutates the input.
 */
export const toggleRoleName = (current: string[], roleName: string, enabled: boolean): string[] => {
  if (enabled) {
    return current.includes(roleName) ? [...current] : [...current, roleName]
  }
  return current.filter((name) => name !== roleName)
}

/**
 * The full set of role names to offer in a group's role picker: every role the
 * server advertises, plus any role the group already confers that the server
 * list is missing (older server, or the roles endpoint failed) — so conferred
 * roles are never invisible or un-removable. Deduplicated, picker order =
 * server order, unknown extras appended.
 */
export const rolePickerOptions = (availableRoles: string[], conferredRoles: string[]): string[] => {
  const options = [...new Set(availableRoles)]
  for (const role of conferredRoles) {
    if (!options.includes(role)) {
      options.push(role)
    }
  }
  return options
}
