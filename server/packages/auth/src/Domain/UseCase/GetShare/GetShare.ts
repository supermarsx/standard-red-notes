import { Result, UniqueEntityId, UseCaseInterface } from '@standardnotes/domain-core'

import { ShareRepositoryInterface } from '../../Share/ShareRepositoryInterface'

import { GetShareDTO } from './GetShareDTO'
import { GetShareResult } from './GetShareResult'

/**
 * PUBLIC, unauthenticated read path. Anyone holding the share link id can fetch
 * the opaque ciphertext. Returns the payload ONLY when the share exists, has not
 * been revoked, and has not been consumed/expired by the burn-after-reading
 * rules. Never leaks the owning user's uuid.
 *
 * Burn semantics:
 * - `oneTimeView`: the share is consumed (revoked) right after the FIRST
 *   successful read, so a second open returns "no longer available".
 * - `viewExpiresMinutes`: once opened, the share remains readable until
 *   `firstOpenedAt + N minutes`, then it expires.
 *
 * Atomicity: the FIRST successful open is decided by an atomic conditional
 * update (`markFirstOpenedAtomically`) that stamps `first_opened_at` only when it
 * is still NULL. Two near-simultaneous opens therefore have exactly one winner;
 * the loser is treated as a subsequent fetch.
 */
export class GetShare implements UseCaseInterface<GetShareResult> {
  constructor(private shareRepository: ShareRepositoryInterface) {}

  async execute(dto: GetShareDTO): Promise<Result<GetShareResult>> {
    const id = new UniqueEntityId(dto.shareId)
    const share = await this.shareRepository.findById(id)

    if (!share || share.props.revoked) {
      return Result.fail('Share not found')
    }

    // Normal (non-burn) share: behave exactly as before.
    if (!share.props.oneTimeView && share.props.viewExpiresMinutes === null) {
      return Result.ok({
        type: share.props.type,
        encryptedPayload: share.props.encryptedPayload,
        oneTimeView: false,
        viewExpiresMinutes: null,
      })
    }

    const now = new Date()

    // Already opened: enforce the post-open rules without re-stamping.
    if (share.props.firstOpenedAt !== null) {
      // A one-time-view share is revoked immediately after its first read, so a
      // still-active one that was already opened only happens for time-limited
      // shares. Enforce the time window if present.
      if (share.props.viewExpiresMinutes !== null) {
        const expiresAt = share.props.firstOpenedAt.getTime() + share.props.viewExpiresMinutes * 60_000
        if (now.getTime() < expiresAt) {
          return Result.ok({
            type: share.props.type,
            encryptedPayload: share.props.encryptedPayload,
            oneTimeView: share.props.oneTimeView,
            viewExpiresMinutes: share.props.viewExpiresMinutes,
          })
        }
        // Window elapsed: expire it (best-effort revoke) and report gone.
        await this.shareRepository.markRevoked(id)
        return Result.fail('Share not found')
      }

      // oneTimeView with no time window that was somehow already opened: consumed.
      return Result.fail('Share not found')
    }

    // First open. Atomically claim it; only the winner proceeds.
    const won = await this.shareRepository.markFirstOpenedAtomically(id, now)
    if (!won) {
      // Lost the race to a concurrent first open. For a one-time-view share the
      // winner consumes it, so this fetch is "no longer available".
      return Result.fail('Share not found')
    }

    // We won the first open. Serve the payload that we already loaded.
    const result: GetShareResult = {
      type: share.props.type,
      encryptedPayload: share.props.encryptedPayload,
      oneTimeView: share.props.oneTimeView,
      viewExpiresMinutes: share.props.viewExpiresMinutes,
    }

    // A pure one-time-view share is consumed right now (no further reads). A
    // time-limited share stays available until firstOpenedAt + window.
    if (share.props.oneTimeView && share.props.viewExpiresMinutes === null) {
      await this.shareRepository.markRevoked(id)
    }

    return Result.ok(result)
  }
}
