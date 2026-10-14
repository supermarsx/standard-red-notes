export type ShareExpiryMetadata = {
  revoked: boolean
  oneTimeView?: boolean
  viewExpiresMinutes?: number | null
  firstOpenedAt?: string | null
}

export function shareExpiresAt(share: ShareExpiryMetadata): number | undefined {
  if (!share.firstOpenedAt || !share.viewExpiresMinutes || share.viewExpiresMinutes <= 0) {
    return undefined
  }
  const opened = new Date(share.firstOpenedAt).getTime()
  return Number.isFinite(opened) ? opened + share.viewExpiresMinutes * 60_000 : undefined
}

export function shareStatus(
  share: ShareExpiryMetadata,
  now: number,
): 'Active' | 'Expired' | 'Burned (opened)' | 'Revoked' {
  const expires = shareExpiresAt(share)
  if (expires !== undefined && now >= expires) {
    return 'Expired'
  }
  const consumed = share.oneTimeView && share.firstOpenedAt && share.viewExpiresMinutes == null
  if (consumed) {
    return 'Burned (opened)'
  }
  return share.revoked ? 'Revoked' : 'Active'
}
