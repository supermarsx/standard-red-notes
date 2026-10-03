import { GrpcTransportFallbackRecorder, grpcTransportFallbackDiagnostics } from './GrpcTransportFallbackDiagnostics'

describe('GrpcTransportFallbackRecorder', () => {
  let clock: number
  const recorder = () => new GrpcTransportFallbackRecorder(() => clock)

  beforeEach(() => {
    clock = 10_000
  })

  it('reports nothing observed, with both lanes at zero, before anything is recorded', () => {
    expect(recorder().report()).toEqual({
      observed: false,
      everDegraded: false,
      lanes: {
        'session-validation': {
          degradedCalls: 0,
          refusedCalls: 0,
          lastFailureClass: null,
          lastFailureAgeMs: null,
        },
        'items-sync': {
          degradedCalls: 0,
          refusedCalls: 0,
          lastFailureClass: null,
          lastFailureAgeMs: null,
        },
      },
    })
  })

  it('counts degradations per lane and leaves the other lane untouched', () => {
    const subject = recorder()
    subject.recordDegradation('session-validation', 'channel-unavailable')
    subject.recordDegradation('session-validation', 'transport-internal')

    const report = subject.report()
    expect(report.lanes['session-validation'].degradedCalls).toBe(2)
    expect(report.lanes['session-validation'].lastFailureClass).toBe('transport-internal')
    expect(report.lanes['items-sync'].degradedCalls).toBe(0)
    expect(report.lanes['items-sync'].lastFailureClass).toBeNull()
  })

  /**
   * A refusal is a FAILED request the gateway deliberately did not paper over.
   * It must never read as a degradation, and it must never read as health.
   */
  it('counts a refusal separately and does NOT report it as a degradation', () => {
    const subject = recorder()
    subject.recordRefusal('items-sync', 'channel-unavailable')

    const report = subject.report()
    expect(report.lanes['items-sync']).toMatchObject({ degradedCalls: 0, refusedCalls: 1 })
    expect(report.observed).toBe(true)
    expect(report.everDegraded).toBe(false)
  })

  it('reports everDegraded as soon as any lane has served a call over HTTP', () => {
    const subject = recorder()
    expect(subject.report().everDegraded).toBe(false)

    subject.recordDegradation('items-sync', 'never-dispatched')
    expect(subject.report().everDegraded).toBe(true)
  })

  it('reports the age of the last failure as a duration, not a timestamp', () => {
    const subject = recorder()
    subject.recordDegradation('session-validation', 'channel-unavailable')
    clock = 12_500

    expect(subject.report().lanes['session-validation'].lastFailureAgeMs).toBe(2_500)
  })

  it('never reports a negative age when the clock moves backwards', () => {
    const subject = recorder()
    subject.recordDegradation('session-validation', 'channel-unavailable')
    clock = 9_000

    expect(subject.report().lanes['session-validation'].lastFailureAgeMs).toBe(0)
  })

  it('exposes the running degradation count a log line can quote', () => {
    const subject = recorder()
    expect(subject.degradedCallsOn('items-sync')).toBe(0)

    subject.recordDegradation('items-sync', 'channel-unavailable')
    subject.recordDegradation('items-sync', 'channel-unavailable')

    expect(subject.degradedCallsOn('items-sync')).toBe(2)
    expect(subject.degradedCallsOn('session-validation')).toBe(0)
  })

  it('clears back to the unobserved report', () => {
    const subject = recorder()
    subject.recordDegradation('items-sync', 'channel-unavailable')
    subject.recordRefusal('session-validation', 'application')
    subject.clear()

    expect(subject.report().observed).toBe(false)
    expect(subject.report().lanes['items-sync'].lastFailureAgeMs).toBeNull()
  })

  /**
   * The secrecy contract the admin diagnostics payload is held to: booleans,
   * counts, durations and closed-enum literals only. Asserted over the
   * SERIALIZED report so a nested free-form field could not slip past.
   */
  it('serializes to booleans, counts, durations and closed-enum literals only', () => {
    const subject = recorder()
    subject.recordDegradation('session-validation', 'channel-unavailable')
    subject.recordRefusal('items-sync', 'application')
    clock = 10_125

    const serialized = JSON.parse(JSON.stringify(subject.report())) as Record<string, unknown>
    const allowedStrings = new Set([
      'channel-unavailable',
      'deadline-exceeded',
      'method-unimplemented',
      'transport-internal',
      'message-limit',
      'cancelled',
      'server-fault',
      'never-dispatched',
      'application',
    ])

    const walk = (value: unknown): void => {
      if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        return
      }
      if (typeof value === 'string') {
        expect(allowedStrings).toContain(value)

        return
      }
      expect(typeof value).toBe('object')
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        expect(key).toMatch(/^[A-Za-z-]+$/)
        walk(nested)
      }
    }

    walk(serialized)
  })

  it('ships a process-global recorder for the proxy and the admin controller to share', () => {
    expect(grpcTransportFallbackDiagnostics).toBeInstanceOf(GrpcTransportFallbackRecorder)
  })
})
