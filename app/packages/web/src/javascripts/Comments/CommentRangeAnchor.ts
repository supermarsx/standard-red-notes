import { WebCrypto } from '@/Application/Crypto'
import type { SuperCommentAnchor } from './comments'

/** An existing signed field preserves authorship when older clients drop range metadata. */
const RANGE_PREFIX = 'range-v1:'

export function isBoundCommentRange(anchor: SuperCommentAnchor): boolean {
  return anchor.blockKey.startsWith(RANGE_PREFIX)
}

export function bindCommentRange(anchor: SuperCommentAnchor): SuperCommentAnchor {
  if (!anchor.exactRange) {
    return anchor
  }
  const { start, end, text } = anchor.exactRange
  const digest = WebCrypto.sodiumCryptoGenericHash(
    JSON.stringify(['standard-red-notes:comment-range:v1', anchor.target, start, end, text]),
  )
  return { ...anchor, blockKey: `${RANGE_PREFIX}${digest}` }
}

export function hasValidCommentRangeDigest(anchor: SuperCommentAnchor): boolean {
  try {
    return !!anchor.exactRange && bindCommentRange(anchor).blockKey === anchor.blockKey
  } catch {
    return false
  }
}

/** Private unsigned anchors are locally trusted; shared ranges require their signed digest. */
export function canUseCommentRange(anchor: SuperCommentAnchor): boolean {
  return !!anchor.exactRange && (!isBoundCommentRange(anchor) || hasValidCommentRangeDigest(anchor))
}
