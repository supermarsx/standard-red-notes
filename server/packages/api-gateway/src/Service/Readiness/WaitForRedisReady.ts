/**
 * Standard Red Notes (C15 / R7): readiness must not go green before the
 * process's own ioredis client has reached `ready`. The client connects
 * asynchronously from the container loader, and the sync lane evaluates its
 * store preconditions PER CALL, so a page load racing a restart used to find
 * `/capabilities` empty and `/ticket` at 503 while `/healthcheck/readiness`
 * already said `ready` — and negotiated HTTP-only for the whole session.
 *
 * The wait is BOUNDED: an unreachable Redis is reported by the readiness
 * report's own `gateway.redis` ping and by the sync lane's transient 503s; it
 * must not keep the listener from ever marking ready.
 */

/** The slice of an ioredis `Redis`/`Cluster` this wait needs. */
export interface RedisReadinessClient {
  status: string
  once(event: 'ready' | 'end', listener: () => void): unknown
  removeListener(event: 'ready' | 'end', listener: () => void): unknown
}

export type RedisReadinessOutcome = 'ready' | 'timeout' | 'ended' | 'none'

export async function waitForRedisReady(
  redis: RedisReadinessClient | undefined,
  timeoutMs: number,
): Promise<RedisReadinessOutcome> {
  if (!redis) {
    return 'none'
  }
  if (redis.status === 'ready') {
    return 'ready'
  }

  return new Promise<RedisReadinessOutcome>((resolve) => {
    let timer: NodeJS.Timeout | undefined
    const settle = (outcome: RedisReadinessOutcome): void => {
      if (timer) {
        clearTimeout(timer)
      }
      redis.removeListener('ready', onReady)
      redis.removeListener('end', onEnd)
      resolve(outcome)
    }
    const onReady = (): void => settle('ready')
    // `end` is ioredis giving up for good (retryStrategy returned null): there
    // will be no `ready`, so stop waiting rather than burn the whole bound.
    const onEnd = (): void => settle('ended')

    redis.once('ready', onReady)
    redis.once('end', onEnd)
    timer = setTimeout(() => settle('timeout'), timeoutMs)
    timer.unref()
  })
}
