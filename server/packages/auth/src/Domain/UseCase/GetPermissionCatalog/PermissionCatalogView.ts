/**
 * Standard Red Notes: one permission in the admin catalog browser — its name,
 * its category (the prefix before the first ':' , or 'general' when it has none)
 * and the names of the active roles that currently grant it.
 */
export interface PermissionCatalogEntry {
  name: string
  category: string
  grantedByRoleNames: string[]
}

export interface PermissionCatalog {
  permissions: PermissionCatalogEntry[]
  categories: string[]
}
