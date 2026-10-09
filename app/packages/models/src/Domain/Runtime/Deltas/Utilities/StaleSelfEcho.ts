import { FullyFormedPayloadInterface } from '../../../Abstract/Payload/Interfaces/UnionTypes'

/**
 * `updated_at_timestamp` is absent on a never-synced payload. `PurePayload` normalizes that (and
 * any negative value) to 0, so 0 means "no comparable server timestamp", never "the epoch".
 */
const NoComparableServerTimestamp = 0

/**
 * Is `apply` the client's own older state coming back, rather than somebody else's newer write?
 *
 * The server assigns `updated_at_timestamp` per row and it is **strictly** monotonic by
 * construction, not by clock: `UpdateExistingItem` computes
 * `Math.max(now, existingItem.timestamps.updatedAt + 1)`, so every accepted write lands strictly
 * above the value the row previously held, even under clock skew or a backwards NTP step. And a
 * write is only accepted when the writer already held the row's current value — with microsecond
 * precision `TimeDifferenceFilter` passes a save only when `incoming - ours === 0`.
 *
 * Two consequences:
 *
 *  - A client's locally held `updated_at_timestamp` is exactly the row's value as of that client's
 *    last acknowledged write to it, and a local edit on top of that does not change it (the
 *    mutator copies the payload and only flips `dirty`).
 *  - The row's value only ever increases.
 *
 * So `apply.updated_at_timestamp >= base.updated_at_timestamp` always holds, and equality holds
 * **if and only if nobody has written the row since this client last wrote it**. An equal (or
 * older) retrieval is therefore this client's own echo: it carries no information the client does
 * not already have, and it must not be allowed to move the user's item.
 *
 * The converse is what keeps genuine conflicts intact: a peer's write raises the row strictly
 * above the value our base recorded, so a real two-device conflict always compares strictly
 * greater and this predicate declines it. There is no window in which a peer write is invisible
 * here, because the server refuses to write the row without advancing the number.
 *
 * A server row with no comparable timestamp of its own (0 — a legacy server that sends no
 * microsecond timestamps, or a payload that never came from a server at all) would compare `<=`
 * against anything and be mistaken for an echo, so that case is declined explicitly.
 *
 * A never-synced *base* also carries 0 and deliberately has NO branch of its own: a real server
 * row carries a positive number, so `apply <= 0` is already false and the comparison declines the
 * case on its own. A separate `base.updated_at_timestamp === 0` guard reads well but cannot change
 * any outcome, which makes it unfalsifiable — a mutation deleting it passes every test. The
 * `never-synced local item` tests pin the behaviour through the comparison instead.
 */
export function isStaleSelfEchoOfBase(apply: FullyFormedPayloadInterface, base: FullyFormedPayloadInterface): boolean {
  if (apply.updated_at_timestamp === NoComparableServerTimestamp) {
    return false
  }

  return apply.updated_at_timestamp <= base.updated_at_timestamp
}
