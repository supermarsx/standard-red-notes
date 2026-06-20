/**
 * Pure (React-free, app-free) helpers backing the Sharing overview pane. Kept
 * separate so the derivation logic — "what is shared", "what's my role", "who is
 * present" — can be unit-tested from plain sample data with no service mocks.
 */

/** The viewer's role in a shared vault, derived from existing service checks. */
export type VaultRole = 'owner' | 'admin' | 'member' | 'readonly'

/** Minimal shape of a present peer (mirrors PresenceRegistry.PresentPeer). */
export type PresenceLike = {
  userUuid?: string
  name: string
  clientId: number
}

/**
 * Decide the viewer's role from the boolean checks the VaultUser service already
 * exposes (isCurrentUserSharedVaultOwner / ...Admin / ...ReadonlyVaultMember).
 * Owner implies admin, so owner is checked first.
 */
export function deriveVaultRole(flags: {
  isOwner: boolean
  isAdmin: boolean
  isReadonly: boolean
}): VaultRole {
  if (flags.isOwner) {
    return 'owner'
  }
  if (flags.isAdmin) {
    return 'admin'
  }
  if (flags.isReadonly) {
    return 'readonly'
  }
  return 'member'
}

/** Human label for a role, for display in the overview. */
export function formatVaultRole(role: VaultRole): string {
  switch (role) {
    case 'owner':
      return 'Owner'
    case 'admin':
      return 'Admin'
    case 'readonly':
      return 'Read-only'
    default:
      return 'Member'
  }
}

/** Roles that grant the viewer permission to remove other members. */
export function canRemoveMembers(role: VaultRole): boolean {
  return role === 'owner' || role === 'admin'
}

/** A non-owner may leave a shared vault; an owner cannot (must transfer/delete). */
export function canLeaveVault(role: VaultRole): boolean {
  return role !== 'owner'
}

export type SharedItemLike = {
  uuid: string
  content_type: string
  /** Best-effort display title (note title, tag name...). May be empty. */
  title?: string
}

export type SharedItemGroup = {
  contentType: string
  label: string
  count: number
  items: SharedItemLike[]
}

/** Friendly plural label for the content types we surface in the overview. */
export function labelForContentType(contentType: string): string {
  switch (contentType) {
    case 'Note':
      return 'Notes'
    case 'Tag':
      return 'Folders & Tags'
    case 'SN|File':
      return 'Files'
    case 'SN|SmartView':
      return 'Smart Views'
    default:
      return contentType
  }
}

/**
 * Group a vault's items by content type into stable, display-ready buckets.
 * Items are sorted by title within each group; groups are returned in a fixed
 * priority order (Notes, Folders & Tags, Files, then the rest alphabetically).
 */
export function groupSharedItemsByType(items: SharedItemLike[]): SharedItemGroup[] {
  const byType = new Map<string, SharedItemLike[]>()
  for (const item of items) {
    const list = byType.get(item.content_type)
    if (list) {
      list.push(item)
    } else {
      byType.set(item.content_type, [item])
    }
  }

  const priority = ['Note', 'Tag', 'SN|File']
  const orderOf = (contentType: string): number => {
    const index = priority.indexOf(contentType)
    return index === -1 ? priority.length : index
  }

  return [...byType.entries()]
    .map(([contentType, groupItems]) => ({
      contentType,
      label: labelForContentType(contentType),
      count: groupItems.length,
      items: [...groupItems].sort((a, b) => (a.title || '').localeCompare(b.title || '')),
    }))
    .sort((a, b) => {
      const delta = orderOf(a.contentType) - orderOf(b.contentType)
      return delta !== 0 ? delta : a.label.localeCompare(b.label)
    })
}

export type PresenceSummary = {
  /** Distinct peers present right now (deduped by userUuid). */
  count: number
  /** Display names of the present peers, in first-seen order. */
  names: string[]
}

/**
 * Reduce a list of live awareness peers to a deduped presence summary. Peers are
 * deduped by published userUuid; peers without one are deduped by clientId.
 */
export function summarizePresence(peers: PresenceLike[]): PresenceSummary {
  const seen = new Set<string>()
  const names: string[] = []
  for (const peer of peers) {
    const key = peer.userUuid || `client:${peer.clientId}`
    if (!seen.has(key)) {
      seen.add(key)
      names.push(peer.name)
    }
  }
  return { count: names.length, names }
}
