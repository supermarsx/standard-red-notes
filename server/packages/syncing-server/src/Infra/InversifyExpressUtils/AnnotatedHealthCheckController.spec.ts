import 'reflect-metadata'

import { Response } from 'express'
import { Repository } from 'typeorm'

import { AnnotatedHealthCheckController } from './AnnotatedHealthCheckController'
import { SQLItem } from '../TypeORM/SQLItem'

/**
 * Standard Red Notes: this controller had NO spec at all, and was excluded from
 * this package's coverage denominator TWICE OVER — by the substring
 * `'HealthCheckController'` and again by the flat `'/Infra/'` entry in
 * `coveragePathIgnorePatterns`. It is the `/healthcheck/readiness` answer for
 * the syncing service: the thing an orchestrator reads to decide whether to
 * keep routing sync traffic here.
 *
 * Readiness is load-bearing in this repo and has shipped a FALSE READOUT twice.
 * The failure mode both times was the same shape: a claim stated more strongly
 * than its evidence — `bound` reported as `ready`, `unread` reported as `down`.
 * So this spec is written to pin, for every check this controller publishes,
 * WHICH of three different things the boolean actually means:
 *
 *   `db: true`     the query resolved          -> a MEASUREMENT
 *   `db: false`    the query rejected OR timed out -> a MEASUREMENT (negative)
 *   `redis: true`  the ping resolved           -> a MEASUREMENT
 *   `redis: false` the ping rejected OR timed out  -> a MEASUREMENT (negative)
 *   `redis: true`  WHEN REDIS IS NOT BOUND     -> a DEFAULT, not a measurement
 *
 * The last line is the one that matters and the reason several assertions below
 * look redundant: the published payload is byte-identical between "Redis
 * answered PING" and "there is no Redis to ask", so the only way to tell them
 * apart from a test is to assert on whether the dependency was CONSULTED. Every
 * unbound-Redis case below therefore asserts `ping` was never called, and the
 * cases where a dependency IS bound assert it was.
 *
 * `reports ready when a dependency is unreachable` is the specific thing this
 * spec is built to fail against. There are five separate assertions that go red
 * if `readiness` is changed to answer 200 regardless: DB rejected, DB hung past
 * the deadline, Redis rejected, Redis hung past the deadline, and both down.
 */
describe('AnnotatedHealthCheckController', () => {
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const makeResponse = (): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))

    return { status: statusMock } as unknown as Response
  }

  // The real controller reaches through `repository.manager.query`, so the fake
  // is shaped the same way round rather than flattened to a `query` method: a
  // flattened fake would pass against a controller that had stopped going
  // through the manager at all.
  const makeRepository = (query: jest.Mock): Repository<SQLItem> =>
    ({ manager: { query } }) as unknown as Repository<SQLItem>

  const hangs = (): jest.Mock => jest.fn().mockReturnValue(new Promise<never>(() => undefined))

  describe('liveness', () => {
    // Liveness must stay dependency-free. An orchestrator RESTARTS a container
    // on a failed liveness probe but merely stops routing to it on a failed
    // readiness probe, so a liveness endpoint that probed the database would
    // turn a DB blip into a restart loop across every syncing-server replica —
    // which is strictly worse than the outage it was reacting to.
    it('answers OK without consulting the database or Redis', async () => {
      const query = jest.fn()
      const ping = jest.fn()

      const controller = new AnnotatedHealthCheckController(makeRepository(query), { ping })

      expect(await controller.get()).toEqual('OK')
      expect(query).not.toHaveBeenCalled()
      expect(ping).not.toHaveBeenCalled()
    })
  })

  describe('readiness with both dependencies bound', () => {
    it('reports ready (200) only after actually probing both', async () => {
      const query = jest.fn().mockResolvedValue([{ 1: 1 }])
      const ping = jest.fn().mockResolvedValue('PONG')

      await new AnnotatedHealthCheckController(makeRepository(query), { ping }).readiness(makeResponse())

      // The probe itself is asserted, not just the verdict. A controller that
      // answered 200 without querying would satisfy a status-only assertion.
      expect(query).toHaveBeenCalledWith('SELECT 1')
      expect(ping).toHaveBeenCalled()
      expect(statusMock).toHaveBeenCalledWith(200)
      expect(jsonMock).toHaveBeenCalledWith({ status: 'ready', checks: { db: true, redis: true } })
    })

    // THE DEPENDENCY SAID NO. A rejected query is a definite negative answer and
    // must read 503, not 200.
    it('reports unavailable (503) when the database rejects the query', async () => {
      const query = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      const ping = jest.fn().mockResolvedValue('PONG')

      await new AnnotatedHealthCheckController(makeRepository(query), { ping }).readiness(makeResponse())

      expect(statusMock).toHaveBeenCalledWith(503)
      expect(jsonMock).toHaveBeenCalledWith({ status: 'unavailable', checks: { db: false, redis: true } })
    })

    it('reports unavailable (503) when Redis rejects the ping', async () => {
      const query = jest.fn().mockResolvedValue([])
      const ping = jest.fn().mockRejectedValue(new Error('redis is loading the dataset in memory'))

      await new AnnotatedHealthCheckController(makeRepository(query), { ping }).readiness(makeResponse())

      expect(statusMock).toHaveBeenCalledWith(503)
      expect(jsonMock).toHaveBeenCalledWith({ status: 'unavailable', checks: { db: true, redis: false } })
    })

    it('reports unavailable (503) and names both when both dependencies are down', async () => {
      const query = jest.fn().mockRejectedValue(new Error('down'))
      const ping = jest.fn().mockRejectedValue(new Error('down'))

      await new AnnotatedHealthCheckController(makeRepository(query), { ping }).readiness(makeResponse())

      expect(statusMock).toHaveBeenCalledWith(503)
      // Both named, so an operator reading this payload is not sent to look at
      // one dependency when two are down.
      expect(jsonMock).toHaveBeenCalledWith({ status: 'unavailable', checks: { db: false, redis: false } })
    })
  })

  describe('readiness when a dependency is UNREACHABLE rather than refusing', () => {
    // I COULD NOT READ THE DEPENDENCY. This is the case the 2 s deadline exists
    // for and the one that had no test: a database that accepts the connection
    // and then never answers `SELECT 1`, which is what a saturated, wedged or
    // network-partitioned DB looks like from here. Without the deadline the
    // readiness request itself hangs, the orchestrator's probe times out with no
    // answer at all, and nothing in the payload ever says why.
    //
    // Fake timers rather than a 2 s sleep, but the REAL `withTimeout`, the real
    // `Promise.race` and the real `setTimeout` reject callback.
    it('reports unavailable (503) when the database accepts the query and never answers', async () => {
      jest.useFakeTimers()
      try {
        const query = hangs()
        const ping = jest.fn().mockResolvedValue('PONG')
        const response = makeResponse()

        const pending = new AnnotatedHealthCheckController(makeRepository(query), { ping }).readiness(response)
        await jest.advanceTimersByTimeAsync(2000)
        await pending

        expect(statusMock).toHaveBeenCalledWith(503)
        expect(jsonMock).toHaveBeenCalledWith({ status: 'unavailable', checks: { db: false, redis: true } })
      } finally {
        jest.useRealTimers()
      }
    })

    it('reports unavailable (503) when Redis accepts the ping and never answers', async () => {
      jest.useFakeTimers()
      try {
        const query = jest.fn().mockResolvedValue([])
        const ping = hangs()
        const response = makeResponse()

        const pending = new AnnotatedHealthCheckController(makeRepository(query), { ping }).readiness(response)
        await jest.advanceTimersByTimeAsync(2000)
        await pending

        expect(statusMock).toHaveBeenCalledWith(503)
        expect(jsonMock).toHaveBeenCalledWith({ status: 'unavailable', checks: { db: true, redis: false } })
      } finally {
        jest.useRealTimers()
      }
    })

    // The deadline must be BOUNDED, not merely present — and the bound is 4 s,
    // not the 2 s the source comment ("a short timeout") reads like.
    //
    // FINDING, pinned here rather than changed: the two probes run SEQUENTIALLY
    // (`await` DB, then `await` Redis), each with its own 2 000 ms deadline, so
    // the worst case for `/healthcheck/readiness` is the SUM. When both
    // dependencies accept their connection and then hang — one partition takes
    // out both, which is the common case, not a contrived one — this endpoint
    // does not answer for 4 s. An orchestrator probe with a 3 s timeout (a
    // frequent default; Kubernetes' own `timeoutSeconds` default is 1) gets NO
    // answer rather than the clean 503 the controller is trying to produce, and
    // a probe that times out is scored as a failure with no payload to explain
    // it. Racing the two checks with `Promise.all` would make the bound 2 s; it
    // is a source change to a package another agent is editing, so it is
    // reported, not made.
    //
    // This test was written first against a single 2 s bound and FAILED by
    // hanging for the full jest timeout, which is how the sequencing was found.
    it('does not answer until BOTH deadlines have elapsed — a 4 s worst case, not 2 s', async () => {
      jest.useFakeTimers()
      try {
        const query = hangs()
        const ping = hangs()
        const response = makeResponse()

        const pending = new AnnotatedHealthCheckController(makeRepository(query), { ping }).readiness(response)

        await jest.advanceTimersByTimeAsync(1999)
        expect(statusMock).not.toHaveBeenCalled()

        // The DB deadline fires here and the Redis probe only STARTS now.
        await jest.advanceTimersByTimeAsync(1)
        expect(statusMock).not.toHaveBeenCalled()

        await jest.advanceTimersByTimeAsync(1999)
        expect(statusMock).not.toHaveBeenCalled()

        await jest.advanceTimersByTimeAsync(1)
        await pending

        expect(statusMock).toHaveBeenCalledWith(503)
        expect(jsonMock).toHaveBeenCalledWith({ status: 'unavailable', checks: { db: false, redis: false } })
      } finally {
        jest.useRealTimers()
      }
    })

    // `withTimeout` clears its timer in a `finally`. If it did not, every
    // readiness poll would leave a live 2 s timer behind; an orchestrator polls
    // this endpoint every few seconds for the life of the container, so the leak
    // would be permanent and would keep the event loop awake. Asserted by timer
    // count under fake timers, which is the only observable this has.
    it('leaves no timer pending once both probes have answered', async () => {
      jest.useFakeTimers()
      try {
        const query = jest.fn().mockResolvedValue([])
        const ping = jest.fn().mockResolvedValue('PONG')

        await new AnnotatedHealthCheckController(makeRepository(query), { ping }).readiness(makeResponse())

        expect(jest.getTimerCount()).toEqual(0)
      } finally {
        jest.useRealTimers()
      }
    })
  })

  describe('readiness when Redis is NOT BOUND', () => {
    // CACHE_TYPE=memory (home-server, single container, LXC) leaves Redis
    // unbound and the controller treats its absence as healthy. That is the
    // documented intent, so it is pinned rather than called a bug — but the
    // payload it publishes, `redis: true`, is byte-identical to the one
    // published when a real Redis answered PING. A reader of
    // `/healthcheck/readiness` CANNOT tell "Redis is up" from "there is no
    // Redis", which is precisely the bound-vs-ready conflation that has shipped
    // as a false readout in this repo before. Recorded as a finding alongside
    // this spec; the fix is a payload change and is not made here.
    it('reports ready (200) with redis true as a DEFAULT, never consulting a ping', async () => {
      const query = jest.fn().mockResolvedValue([])

      await new AnnotatedHealthCheckController(makeRepository(query), undefined).readiness(makeResponse())

      expect(statusMock).toHaveBeenCalledWith(200)
      expect(jsonMock).toHaveBeenCalledWith({ status: 'ready', checks: { db: true, redis: true } })
      // The DB, by contrast, is genuinely measured even on this topology.
      expect(query).toHaveBeenCalledWith('SELECT 1')
    })

    // The unbound-Redis default must not be allowed to carry the whole verdict.
    // A readiness that answered 200 here would keep sync traffic routed at a
    // replica with no database on exactly the topology — single container — that
    // has no second replica to route to instead.
    it('still reports unavailable (503) when the database is down and Redis is unbound', async () => {
      const query = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))

      await new AnnotatedHealthCheckController(makeRepository(query), undefined).readiness(makeResponse())

      expect(statusMock).toHaveBeenCalledWith(503)
      expect(jsonMock).toHaveBeenCalledWith({ status: 'unavailable', checks: { db: false, redis: true } })
    })
  })

  describe('what the published booleans do NOT mean', () => {
    // Observed behaviour, pinned so it cannot change silently and so nobody
    // reads more into `redis: true` than is there: the controller checks only
    // that the ping call RESOLVED. It never looks at the value. A Redis that
    // answers PING with something other than PONG — a proxy in front of it, a
    // protocol-level mismatch, a stub — reads as ready.
    //
    // This is deliberately NOT asserted as "not an error": it asserts the
    // positive 200/ready payload for a specific non-PONG value, so it cannot
    // pass just because some unrelated error stopped happening.
    it('counts any resolved ping as healthy, including a non-PONG reply', async () => {
      const query = jest.fn().mockResolvedValue([])
      const ping = jest.fn().mockResolvedValue('not-pong')

      await new AnnotatedHealthCheckController(makeRepository(query), { ping }).readiness(makeResponse())

      expect(statusMock).toHaveBeenCalledWith(200)
      expect(jsonMock).toHaveBeenCalledWith({ status: 'ready', checks: { db: true, redis: true } })
    })

    // Same shape for the database: an empty result set is a perfectly good
    // answer to `SELECT 1` as far as this check is concerned. What is being
    // pinned is that `db: true` means "the server answered", not "the schema is
    // migrated" or "the data is there" — a distinction an operator reading a
    // green readiness during a failed migration would otherwise get wrong.
    it('counts any resolved query as healthy, including an empty result set', async () => {
      const query = jest.fn().mockResolvedValue([])
      const ping = jest.fn().mockResolvedValue('PONG')

      await new AnnotatedHealthCheckController(makeRepository(query), { ping }).readiness(makeResponse())

      expect(statusMock).toHaveBeenCalledWith(200)
      expect(jsonMock).toHaveBeenCalledWith({ status: 'ready', checks: { db: true, redis: true } })
    })
  })
})
