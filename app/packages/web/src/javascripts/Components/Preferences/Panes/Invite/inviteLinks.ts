import { HttpResponse, isErrorResponse } from '@standardnotes/snjs'

/**
 * Standard Red Notes: pure helpers backing the user-facing self-serve Invite pane
 * (t69 §7.5). These parse the `/v1/users/me/invite-links` responses surfaced by
 * `application.legacyApi.{listMyInviteLinks,createMyInviteLink,revokeMyInviteLink}`
 * and format the pieces the pane renders. Kept dependency-free (no React, no
 * application handle) so they are trivially unit-testable and so the menu
 * controller can reuse {@link parseSelfServeInviteState} to gate the pane.
 *
 * A self-serve (user) link can NEVER carry a role / domain override or bypass
 * approval — the auth server enforces that privilege guard — so, unlike the admin
 * create form, this pane offers ONLY max-uses, expiry and label.
 */

export type InviteLinkStatus = 'active' | 'exhausted' | 'expired' | 'revoked'

/** One of the caller's OWN invite links, as returned by listMyInviteLinks (never carries the token). */
export type SelfServeInviteLinkView = {
  uuid: string
  label?: string | null
  maxUses: number
  usedCount: number
  remainingUses: number
  expiresAt?: string | null
  revoked: boolean
  status: InviteLinkStatus
  createdAt: string
  /** Per-link attribution (people who signed up via this link), when the server exposes it. */
  invitedCount?: number
}

/** The one-time create response — the raw token + relative path are here ONLY at create. */
export type SelfServeInviteLinkCreated = SelfServeInviteLinkView & {
  token: string
  path: string
}

/**
 * The resolved self-serve state derived from a list response. `enabled` drives
 * whether the pane/menu entry is shown at all; `invitesPerUser` is the quota
 * "total" (undefined when the server didn't expose it).
 */
export type SelfServeInviteState = {
  enabled: boolean
  invitesPerUser?: number
  links: SelfServeInviteLinkView[]
  /** People this user has invited (top-level attribution, else summed usedCount). */
  invitedCount: number
}

export type SelfServeFormResult<T> = { ok: true; value: T } | { ok: false; error: string }

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const KNOWN_STATUSES: InviteLinkStatus[] = ['active', 'exhausted', 'expired', 'revoked']

/**
 * Recompute a display status from the raw fields when the server didn't send one
 * (or sent an unknown value). Precedence mirrors the auth entity: revoked >
 * expired > exhausted > active. This is display-only; the server's atomic
 * consume remains the authority on whether a slot is actually available.
 */
const deriveStatus = (revoked: boolean, expiresAt: string | null | undefined, remaining: number): InviteLinkStatus => {
  if (revoked) {
    return 'revoked'
  }
  if (expiresAt) {
    const expiry = new Date(expiresAt)
    if (!Number.isNaN(expiry.getTime()) && expiry.getTime() <= Date.now()) {
      return 'expired'
    }
  }
  if (remaining <= 0) {
    return 'exhausted'
  }
  return 'active'
}

/** Normalise one raw link record into a {@link SelfServeInviteLinkView}. */
export const parseInviteLink = (raw: unknown): SelfServeInviteLinkView | undefined => {
  const record = asRecord(raw)
  if (!record || typeof record.uuid !== 'string') {
    return undefined
  }
  const maxUses = numberOr(record.maxUses, 1)
  const usedCount = numberOr(record.usedCount, 0)
  const remainingUses = numberOr(record.remainingUses, Math.max(0, maxUses - usedCount))
  const revoked = record.revoked === true
  const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : null
  const rawStatus = asString(record.status) as InviteLinkStatus
  const status = KNOWN_STATUSES.includes(rawStatus) ? rawStatus : deriveStatus(revoked, expiresAt, remainingUses)
  const invitedCount = typeof record.invitedCount === 'number' ? record.invitedCount : undefined

  return {
    uuid: record.uuid,
    label: typeof record.label === 'string' ? record.label : null,
    maxUses,
    usedCount,
    remainingUses,
    expiresAt,
    revoked,
    status,
    createdAt: asString(record.createdAt),
    invitedCount,
  }
}

/**
 * Resolve the self-serve state from a listMyInviteLinks() response.
 *
 * Gating: the pane is `enabled` only when self-serve is available. We treat it as
 * available when the call returns a non-error response carrying an `inviteLinks`
 * array AND the server-reported quota (`invitesPerUser`) is not explicitly 0. A
 * disabled server is expected to answer non-2xx OR `invitesPerUser: 0`; either
 * hides the pane. When the server omits `invitesPerUser` entirely the quota is
 * left undefined and the pane shows the active-link count without a cap.
 */
export const parseSelfServeInviteState = (response: HttpResponse): SelfServeInviteState => {
  if (isErrorResponse(response)) {
    return { enabled: false, links: [], invitedCount: 0 }
  }

  const data = asRecord((response as { data?: unknown }).data)
  const rawLinks = data?.inviteLinks
  if (!Array.isArray(rawLinks)) {
    return { enabled: false, links: [], invitedCount: 0 }
  }

  const links = rawLinks
    .map(parseInviteLink)
    .filter((link): link is SelfServeInviteLinkView => link !== undefined)

  const invitesPerUser = typeof data?.invitesPerUser === 'number' ? data.invitesPerUser : undefined
  const enabled = invitesPerUser === undefined ? true : invitesPerUser > 0

  const invitedCount =
    typeof data?.invitedCount === 'number'
      ? data.invitedCount
      : links.reduce((sum, link) => sum + link.usedCount, 0)

  return { enabled, invitesPerUser, links, invitedCount }
}

/** Extract the one-time created link (token + path) from a createMyInviteLink() response. */
export const parseCreatedInviteLink = (response: HttpResponse): SelfServeInviteLinkCreated | undefined => {
  if (isErrorResponse(response)) {
    return undefined
  }
  const data = asRecord((response as { data?: unknown }).data)
  const record = asRecord(data?.inviteLink)
  const base = parseInviteLink(record)
  if (!base || !record || typeof record.token !== 'string' || typeof record.path !== 'string') {
    return undefined
  }
  return { ...base, token: record.token, path: record.path }
}

/** The number of the caller's links that are currently active (count against the quota). */
export const activeInviteLinkCount = (links: SelfServeInviteLinkView[]): number =>
  links.filter((link) => link.status === 'active').length

/** Short label for an invite-link status chip. Unknown falls back to the raw string. */
export const inviteLinkStatusLabel = (status: string | null | undefined): string => {
  switch (status) {
    case 'active':
      return 'Active'
    case 'exhausted':
      return 'Exhausted'
    case 'expired':
      return 'Expired'
    case 'revoked':
      return 'Revoked'
    default:
      return status ?? 'Unknown'
  }
}

/** Chip classes for an invite-link status: green active, neutral spent, red revoked. */
export const inviteLinkStatusChipClass = (status: string | null | undefined): string => {
  switch (status) {
    case 'active':
      return 'bg-success text-success-contrast'
    case 'exhausted':
    case 'expired':
      return 'bg-passive-4 text-foreground'
    case 'revoked':
      return 'bg-danger text-danger-contrast'
    default:
      return 'bg-passive-4 text-foreground'
  }
}

/** "used / max" label for an invite link's uses cell. */
export const inviteLinkUsesLabel = (usedCount: number, maxUses: number): string => `${usedCount}/${maxUses}`

/**
 * Absolute invite URL to hand out, composed from the current origin + the
 * server-returned relative path (`/?invite=<token>`). Keeping the origin
 * client-side avoids any server base-url dependency.
 */
export const inviteLinkAbsoluteUrl = (origin: string, path: string): string => `${origin}${path}`

/** Human date-time for an invite-link expiry / created cell; blank/never -> the fallback. */
export const formatInviteLinkDate = (value: string | null | undefined, whenEmpty = '—'): string => {
  if (!value) {
    return whenEmpty
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/** The editable create-invite-link form state (self-serve: NO role / domain fields). */
export type CreateInviteForm = {
  maxUses: string
  expiresInHours: string
  label: string
}

/** The body sent to createMyInviteLink (only the fields the user actually set). */
export type CreateInviteBody = {
  maxUses: number
  expiresInHours: number | null
  label: string | null
}

export const emptyCreateInviteForm = (): CreateInviteForm => ({
  maxUses: '1',
  expiresInHours: '',
  label: '',
})

/**
 * Validate + normalise the create form into the request body. maxUses defaults to
 * 1 (single-use) and is clamped to 1..100000; a blank expiry means "never"; a
 * blank label -> null. Role / domain are deliberately absent — the server would
 * reject them on a user link (privilege guard) and the pane never offers them.
 */
export const buildCreateInviteBody = (form: CreateInviteForm): SelfServeFormResult<CreateInviteBody> => {
  const maxUsesRaw = form.maxUses.trim()
  const maxUses = maxUsesRaw === '' ? 1 : Number(maxUsesRaw)
  if (!Number.isFinite(maxUses) || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000) {
    return { ok: false, error: 'Max uses must be a whole number from 1 to 100000 (1 = single-use).' }
  }

  const expiryRaw = form.expiresInHours.trim()
  let expiresInHours: number | null = null
  if (expiryRaw !== '') {
    const value = Number(expiryRaw)
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 8760) {
      return { ok: false, error: 'Expiry must be a whole number of hours from 1 to 8760 (1 year), or blank for never.' }
    }
    expiresInHours = value
  }

  const label = form.label.trim() === '' ? null : form.label.trim()

  return { ok: true, value: { maxUses, expiresInHours, label } }
}
