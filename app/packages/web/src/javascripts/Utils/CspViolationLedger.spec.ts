import { CSP_DIRECTIVES, CspViolationLedger, installCspViolationLedger, readCspViolations } from './CspViolationLedger'

/** Everything a real violation event carries. Only two of these fields may be read. */
const violation = (overrides: Record<string, unknown> = {}) => ({
  effectiveDirective: 'style-src-elem',
  violatedDirective: 'style-src-elem',
  disposition: 'enforce',
  blockedURI: 'https://cdn.internal.example/secret/path.css?token=hunter2',
  documentURI: 'https://notes.internal.example/app?session=hunter2',
  sourceFile: 'https://notes.internal.example/app.js',
  sample: 'window.secret = "hunter2"',
  originalPolicy: "default-src 'self'; connect-src https://sync.internal.example",
  referrer: 'https://notes.internal.example/',
  ...overrides,
})

describe('CspViolationLedger', () => {
  it('counts each refusal against the directive that fired', () => {
    const ledger = new CspViolationLedger(() => 0)

    ledger.record(violation())
    ledger.record(violation())
    ledger.record(violation({ effectiveDirective: 'connect-src' }))

    expect(ledger.reading()).toEqual({
      total: 3,
      enforced: 3,
      byDirective: { 'style-src-elem': 2, 'connect-src': 1 },
      armedForMs: 0,
    })
  })

  it('starts at a measured zero, and says how long it has been listening', () => {
    let clock = 1_000
    const ledger = new CspViolationLedger(() => clock)
    clock += 90_000

    expect(ledger.reading()).toEqual({ total: 0, enforced: 0, byDirective: {}, armedForMs: 90_000 })
  })

  it('tells a refusal that blocked something from one that was only reported', () => {
    const ledger = new CspViolationLedger(() => 0)

    ledger.record(violation({ disposition: 'report' }))
    ledger.record(violation({ disposition: 'enforce' }))
    // A disposition the event did not say is treated as the one that blocks.
    ledger.record(violation({ disposition: undefined }))

    expect(ledger.reading().total).toBe(3)
    expect(ledger.reading().enforced).toBe(2)
  })

  /**
   * *** THE WHOLE POINT OF THE CLOSED LIST. *** A violation event is full of
   * addresses, paths and code. The reading may contain a directive name from this
   * build's list, counts, and a duration — and nothing the event said.
   */
  it('keeps nothing from the event but a directive name on its own list', () => {
    const ledger = new CspViolationLedger(() => 0)

    ledger.record(violation())
    ledger.record(
      violation({
        effectiveDirective: 'https://evil.internal.example/?token=hunter2',
        violatedDirective: 'https://evil.internal.example/?token=hunter2',
      }),
    )
    ledger.record(violation({ effectiveDirective: undefined, violatedDirective: 'a-directive-from-the-future' }))
    ledger.record(violation({ effectiveDirective: 42, violatedDirective: { toString: () => 'hunter2' } }))

    const serialised = JSON.stringify(ledger.reading())

    expect(serialised).not.toContain('hunter2')
    expect(serialised).not.toContain('internal.example')
    expect(serialised).not.toContain('a-directive-from-the-future')
    expect(ledger.reading().byDirective).toEqual({ 'style-src-elem': 1, other: 3 })
    for (const key of Object.keys(ledger.reading().byDirective)) {
      expect([...CSP_DIRECTIVES, 'other']).toContain(key)
    }
  })

  it('reads the directive name off an older engine’s field, which carries the value after it', () => {
    const ledger = new CspViolationLedger(() => 0)

    ledger.record(
      violation({ effectiveDirective: undefined, violatedDirective: "script-src 'self' https://x.internal.example" }),
    )

    expect(ledger.reading().byDirective).toEqual({ 'script-src': 1 })
    expect(JSON.stringify(ledger.reading())).not.toContain('internal.example')
  })
})

describe('the page’s one ledger', () => {
  it('listens for the browser’s violation event, once, however often it is installed', () => {
    // The module arms itself against the real document on import.
    const before = readCspViolations()
    expect(before).toBeDefined()

    const listeners: string[] = []
    const again = installCspViolationLedger({
      addEventListener: (type: string) => {
        listeners.push(type)
      },
    } as unknown as Document)

    // Already armed: no second listener, and the same ledger.
    expect(listeners).toEqual([])
    expect(again).toBeDefined()

    const total = readCspViolations()?.total ?? 0
    document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), violation()))
    document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), violation({ disposition: 'report' })))

    expect(readCspViolations()?.total).toBe(total + 2)
    expect(JSON.stringify(readCspViolations())).not.toContain('hunter2')
  })
})
