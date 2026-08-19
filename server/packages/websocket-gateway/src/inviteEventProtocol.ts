import {
  InviteEventInvalidation,
  InviteEventReplay,
  isInviteEventInvalidation,
  isOpaqueInviteEventCursor,
  MAX_INVITE_REPLAY_BATCH,
  StoredInviteEvent,
} from './inviteEventStore.js'

const REPLAY_FIELDS = new Set(['previousCursor', 'events', 'nextCursor', 'hasMore'])

/** Single strict wire validator for gateway handlers and compatibility tests. */
export function isStoredInviteEvent(value: unknown): value is StoredInviteEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  if (!isOpaqueInviteEventCursor(candidate.streamPosition)) {
    return false
  }
  const { streamPosition: _streamPosition, ...event } = candidate
  return isInviteEventInvalidation(event as InviteEventInvalidation)
}

/**
 * Validates the complete durable replay contract. This is intentionally kept
 * outside the socket multiplexer so server/store schemas cannot drift again.
 */
export function isInviteEventReplay(value: unknown, expectedCursor: string, limit: number): value is InviteEventReplay {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isOpaqueInviteEventCursor(expectedCursor) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_INVITE_REPLAY_BATCH
  ) {
    return false
  }
  const replay = value as Record<string, unknown>
  if (
    !Object.keys(replay).every((field) => REPLAY_FIELDS.has(field)) ||
    replay.previousCursor !== expectedCursor ||
    !isOpaqueInviteEventCursor(replay.nextCursor) ||
    !Array.isArray(replay.events) ||
    replay.events.length > limit ||
    typeof replay.hasMore !== 'boolean' ||
    !replay.events.every(isStoredInviteEvent)
  ) {
    return false
  }
  if (replay.events.length === 0) {
    return replay.nextCursor === expectedCursor && replay.hasMore === false
  }
  const positions = replay.events.map((event) => event.streamPosition)
  return (
    new Set(positions).size === positions.length &&
    positions.every((position) => position !== expectedCursor) &&
    positions.at(-1) === replay.nextCursor
  )
}
