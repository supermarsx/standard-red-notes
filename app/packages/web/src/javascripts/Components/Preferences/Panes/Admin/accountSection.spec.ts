import {
  ACCOUNT_ROLES,
  ADMIN_READINGS,
  buildAccountSection,
  describeAdminReading,
  describeFileQuota,
  describeSubscription,
  FILE_ALLOWANCE_ORIGINS,
  FILE_QUOTA_NEAR_FRACTION,
  fileQuotaFraction,
  SPACE_FIGURE_SOURCES,
  SUBSCRIPTION_PLANS,
  unconsumableOperationCount,
  unrecognisedRoleCount,
  wholeMegabytes,
  type AccountObservations,
  type AccountSectionInput,
} from './accountSection'
import { EFFORT_LABEL } from './diagnosticRemedies'
import type { DiagnosticFinding, DiagnosticRow, SectionModel } from './diagnosticsSections'

/**
 * Standard Red Notes: the Account section's own tests.
 *
 * *** WHAT THIS FILE IS FOR, IN ORDER OF HOW BADLY IT WOULD HURT TO GET WRONG ***
 *
 * 1. **No identifier ever leaves.** This is the one section of the pane whose
 *    subject is a person, and the copyable report is written to be pasted in
 *    public. So the privacy suite plants an e-mail address, a user uuid and an IP
 *    address into EVERY place a caller could put one — the wide-string fields the
 *    section does read, and extra keys it does not — and asserts, per candidate,
 *    that none of them reaches a row, a note, a finding, a remedy or a report
 *    line. It then asserts that no eight-character FRAGMENT of any of them
 *    appears either, because a partial scrub is a failure mode this codebase has
 *    actually shipped, and "the planted string is absent" passes happily over a
 *    truncated one.
 *
 * 2. **A 403 and a 401 are opposite answers.** Both are asserted in both
 *    directions: on a 403 the role row is broken and the session row is healthy;
 *    on a 401 the session row is broken and the role row claims NOTHING. An
 *    assertion on only one of the pair would be satisfied by a section that
 *    collapsed the two statuses into "could not read".
 *
 * 3. **Absent is not zero, and absent is not healthy.** The flattering direction
 *    is the dangerous one, so there are assertions that an unreported allowance
 *    does not read as room available and that an unreported figure does not read
 *    as 0.
 *
 * 4. **A proxy claim is capped.** The client's own cached role list is a
 *    `correlated` signal in both directions, and the row is asserted to be capped
 *    in both — including the negative arm, because a `broken` claim surviving on a
 *    merely correlated signal is the exact defect the contract's caveat machinery
 *    was written for.
 *
 * Every assertion is made per ROW rather than over a set of rows: an assertion
 * over a set is satisfied by any member of it, and a renamed label would silently
 * turn an assertion into a pass — which is why `rowOf` throws instead of
 * returning undefined. There is no `describe.skip` in this file and there must
 * never be one: the builder is pure and takes its facts as arguments, so there is
 * nothing about the environment to branch on.
 */

/* -------------------------------------------------------------------------- */
/* Planted identifiers                                                        */
/* -------------------------------------------------------------------------- */

const PLANTED_EMAIL = 'plantedperson@zzmarkerzz.test'

const PLANTED_UUID = '9f1c2b7e-0000-4aaa-bbbb-5c6d7e8f9a0b'

const PLANTED_IP = '203.0.113.77'

const PLANTED_SESSION_UUID = 'aa71de44-1111-4ccc-dddd-6e7f8a9b0c1d'

const PLANTED_DEVICE_ID = 'device-zzmarkerzz-0099'

const PLANTED_IDENTIFIERS = [PLANTED_EMAIL, PLANTED_UUID, PLANTED_IP, PLANTED_SESSION_UUID, PLANTED_DEVICE_ID] as const

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const MB = 1_048_576

const healthyObservations = (overrides: Partial<AccountObservations> = {}): AccountObservations => ({
  signedIn: true,
  firstPartyServer: true,
  clientBelievesAdmin: true,
  roles: ['ADMIN_USER', 'PRO_USER'],
  entitledToSharedVaults: true,
  subscriptionPresent: true,
  subscriptionPlan: 'PRO_PLAN',
  subscriptionCancelled: false,
  subscriptionEndsInSeconds: 86_400 * 30,
  offlineSubscription: false,
  fileUploadBytesUsed: 100 * MB,
  fileUploadBytesLimit: 1000 * MB,
  localUsageBytes: 50 * MB,
  localSoftCapBytes: 500 * MB,
  protocolVersion: 3,
  serverOperations: ['SYNC_ITEMS', 'API_RPC', 'FILES_V1'],
  ...overrides,
})

const healthySection = (overrides: Partial<AccountSectionInput> = {}): SectionModel =>
  buildAccountSection({
    observations: healthyObservations(),
    adminAccess: { payloadRead: true },
    ...overrides,
  })

/* -------------------------------------------------------------------------- */
/* Lookups that fail loudly                                                   */
/* -------------------------------------------------------------------------- */

const allRows = (model: SectionModel): readonly DiagnosticRow[] => model.blocks.flatMap((block) => block.rows)

const allFindings = (model: SectionModel): readonly DiagnosticFinding[] =>
  model.blocks.flatMap((block) => block.findings)

/**
 * A missing row THROWS rather than returning undefined, so a renamed label fails
 * the suite instead of quietly satisfying every assertion about that row.
 */
const rowOf = (model: SectionModel, label: string): DiagnosticRow => {
  const found = allRows(model).find((row) => row.label === label)
  if (found === undefined) {
    throw new Error(
      `no row labelled "${label}" — the model has: ${allRows(model)
        .map((row) => row.label)
        .join(' | ')}`,
    )
  }
  return found
}

const findingOf = (model: SectionModel, code: string): DiagnosticFinding | undefined =>
  allFindings(model).find((finding) => finding.code === code)

const codesOf = (model: SectionModel): string[] => allFindings(model).map((finding) => String(finding.code))

/** Everything the model could possibly put in front of a reader, as one string. */
const everything = (model: SectionModel): string => `${JSON.stringify(model)}\n${model.reportLines.join('\n')}`

const UNRECOGNISED_ROLES_LABEL = 'Roles outside this build’s taxonomy'

/* -------------------------------------------------------------------------- */
/* 1. Privacy: no identifier, and no fragment of one, ever leaves             */
/* -------------------------------------------------------------------------- */

describe('buildAccountSection never discloses an account identifier', () => {
  /**
   * Plant every identifier in every place a caller could put one.
   *
   * The wide-string fields this section genuinely reads — role names, the
   * subscription plan, the server's operation list — get one each, because those
   * are the only paths by which a server-supplied string reaches this module at
   * all. The extra keys (`email`, `userUuid`, `sessionUuid`, `deviceId`,
   * `ipAddress`, `subscriptionUuid`) are NOT members of `AccountObservations` and
   * are attached through a cast on purpose: they prove the builder reads the
   * fields it declares rather than enumerating whatever it was handed, which is
   * the behavioural form of the type-level guarantee in the module header.
   */
  const plantedObservations = (): AccountObservations => {
    const extras: Record<string, unknown> = {
      email: PLANTED_EMAIL,
      userUuid: PLANTED_UUID,
      sessionUuid: PLANTED_SESSION_UUID,
      deviceId: PLANTED_DEVICE_ID,
      ipAddress: PLANTED_IP,
      subscriptionUuid: PLANTED_UUID,
      userEmail: PLANTED_EMAIL,
    }

    return {
      ...healthyObservations({
        roles: ['ADMIN_USER', PLANTED_EMAIL, PLANTED_UUID, PLANTED_IP],
        subscriptionPlan: PLANTED_UUID,
        serverOperations: ['SYNC_ITEMS', PLANTED_EMAIL, PLANTED_DEVICE_ID],
        // The newest wide `string` members, added to the sweep in the same change
        // that added each field: a closed-set member that is not planted here is a
        // path the privacy suite does not cover, and every one of this pane's four
        // leaks got in through a field nobody had swept.
        fileCensus: PLANTED_SESSION_UUID,
        // The allowance provenance is a SERVER enum, and the server that sends it
        // is the same one that holds this account's subscription uuid — exactly the
        // adjacency that puts an identifier in the wrong field. Planted with the
        // uuid for that reason rather than with an arbitrary marker.
        fileAllowanceOrigin: PLANTED_UUID,
      }),
      ...extras,
    } as unknown as AccountObservations
  }

  const plantedSection = (): SectionModel =>
    buildAccountSection({ observations: plantedObservations(), adminAccess: { payloadRead: true } })

  /**
   * *** THE SWEEP'S OWN NON-VACUITY, FIELD BY FIELD. ***
   *
   * Asserted BEFORE the refusals, and per field rather than per identifier: an
   * identifier that is no longer anywhere in the INPUT cannot be kept out of the
   * output by anything, so a fixture that quietly stopped carrying one — a field
   * renamed, a plant dropped in a merge — would leave its half of this scan
   * reading green forever. A passing secrecy test over an unpoisoned field is the
   * worst shape a gate can take, because it is indistinguishable from protection.
   *
   * Every WIDE `string` member the module reads is named here explicitly, so
   * adding such a member without adding its plant fails this test rather than
   * silently widening the surface. `fileAllowanceOrigin` is the newest, and it is
   * planted with the account UUID on purpose: it is a SERVER enum sent by the same
   * service that holds this account's subscription uuid, which is precisely the
   * adjacency that puts an identifier into the wrong field.
   */
  it('actually feeds every planted identifier into the section, through every field it reads', () => {
    const observations = plantedObservations() as unknown as Record<string, unknown>
    const serialisedInput = JSON.stringify(observations)

    for (const planted of PLANTED_IDENTIFIERS) {
      expect(serialisedInput).toContain(planted)
    }

    for (const field of ['roles', 'subscriptionPlan', 'serverOperations', 'fileCensus', 'fileAllowanceOrigin']) {
      expect({
        field,
        poisoned: PLANTED_IDENTIFIERS.some((planted) => JSON.stringify(observations[field]).includes(planted)),
      }).toEqual({
        field,
        poisoned: true,
      })
    }
  })

  it.each(PLANTED_IDENTIFIERS)('keeps %s out of every row value', (planted) => {
    const model = plantedSection()

    for (const row of allRows(model)) {
      expect(String(row.value)).not.toContain(planted)
      expect(String(row.label)).not.toContain(planted)
      expect(row.note).not.toContain(planted)
      expect(row.caveat ?? '').not.toContain(planted)
    }
  })

  it.each(PLANTED_IDENTIFIERS)('keeps %s out of every report line', (planted) => {
    const model = plantedSection()

    for (const line of model.reportLines) {
      expect(String(line)).not.toContain(planted)
    }
  })

  it.each(PLANTED_IDENTIFIERS)('keeps %s out of every finding, title, detail and remedy', (planted) => {
    const model = plantedSection()

    for (const finding of allFindings(model)) {
      expect(JSON.stringify(finding)).not.toContain(planted)
    }
  })

  /**
   * A PARTIAL scrub is not a save.
   *
   * Asserting only that the whole planted string is absent passes over a value
   * that was truncated, split at an `@`, or had one character replaced — all of
   * which still identify a person. So every eight-character window of every
   * planted value is required to be absent from the entire model.
   */
  it('leaves no eight-character fragment of any planted identifier anywhere in the model', () => {
    const output = everything(plantedSection())

    for (const planted of PLANTED_IDENTIFIERS) {
      const fragments: string[] = []
      for (let start = 0; start + 8 <= planted.length; start += 1) {
        fragments.push(planted.slice(start, start + 8))
      }

      expect(fragments.length).toBeGreaterThanOrEqual(4)
      for (const fragment of fragments) {
        expect(output).not.toContain(fragment)
      }
    }
  })

  it('counts an unrecognised role rather than naming it', () => {
    const model = plantedSection()
    const row = rowOf(model, UNRECOGNISED_ROLES_LABEL)

    expect(row.value).toBe('3')
    expect(row.evidence.kind).toBe('direct')
    expect(row.verdict).toBe('informational')
    expect(rowOf(model, 'Role: Admin user').value).toBe('held')
    expect(rowOf(model, 'Role: Full user').value).toBe('not held')
  })

  /**
   * *** FIVE EMPTY ROWS COLLAPSE TO ONE, AND ONLY WHEN THEY ARE ALL EMPTY. ***
   *
   * Both arms are asserted, because a collapse that fired whenever it felt like it
   * would hide a real role reading, and one that never fired would leave the five
   * "not reported" rows the operator read as five failures.
   */
  it('says in one row that nothing produces the role names, rather than five empty rows', () => {
    const model = buildAccountSection({
      observations: { signedIn: true },
      adminAccess: { payloadRead: true },
    })
    const labels = allRows(model).map((row) => String(row.label))

    expect(rowOf(model, 'Roles held by this account').value).toBe('not exposed by any client surface')
    expect(rowOf(model, 'Roles held by this account').verdict).toBe('undetermined')
    expect(rowOf(model, 'Roles held by this account').claimed).toBe('informational')
    expect(labels).not.toContain('Role: Admin user')
    expect(labels).not.toContain(UNRECOGNISED_ROLES_LABEL)
    // The row that DOES ask the server is untouched by the collapse.
    expect(rowOf(model, 'Admin role, as the server answered').verdict).toBe('healthy')
  })

  it('renders the per-role rows the moment a caller supplies the names', () => {
    const model = healthySection()
    const labels = allRows(model).map((row) => String(row.label))

    expect(labels).not.toContain('Roles held by this account')
    expect(rowOf(model, 'Role: Admin user').value).toBe('held')
    expect(rowOf(model, UNRECOGNISED_ROLES_LABEL).value).toBe('0')
  })

  it('refuses a plan name outside the three it knows instead of echoing it', () => {
    expect(rowOf(plantedSection(), 'Subscription plan').value).toBe('other (unrecognised)')
  })

  it('counts an unconsumable operation rather than naming it', () => {
    const model = plantedSection()
    const row = rowOf(model, 'Operations this client cannot consume')

    expect(row.value).toBe('2')
    expect(row.verdict).toBe('degraded')
    expect(findingOf(model, 'CLIENT_GAP')?.remedy?.effort).toBe('client-update')
    expect(JSON.stringify(findingOf(model, 'CLIENT_GAP'))).not.toContain(PLANTED_EMAIL)
  })

  it('states the withholdings in the report, so "not collected" is distinguishable from "not disclosed"', () => {
    const report = healthySection().reportLines.join('\n')

    expect(report).toContain('## Account, space & requirements')
    expect(report).toContain(
      '- Account identifiers: never collected by this section: e-mail address, account id, session id, device id, client IP address and subscription id',
    )
    expect(report).toContain('- Byte figures: reduced to closed buckets and whole megabytes before they are reported')
    expect(report).toContain('- Uploaded files: reported as present, none or not loaded; never counted and never named')
    expect(report).toContain(
      '- Per-account feature flags: not reported by any server build; only a refusal observed on the sync lane evidences them',
    )
  })

  it('reports no byte figure more precise than a whole megabyte or a bucket', () => {
    const model = buildAccountSection({
      observations: healthyObservations({
        fileUploadBytesUsed: 123_456_789,
        fileUploadBytesLimit: 987_654_321,
      }),
    })
    const report = model.reportLines.join('\n')

    expect(report).not.toContain('123456789')
    expect(report).not.toContain('987654321')
    expect(rowOf(model, 'Server file bytes used, whole MB').value).toBe('117')
    expect(rowOf(model, 'Server file allowance, whole MB').value).toBe('941')
    expect(rowOf(model, 'Server file allowance used').value).toBe('0-25%')
  })
})

/* -------------------------------------------------------------------------- */
/* 2. A 403 and a 401 are opposite answers                                    */
/* -------------------------------------------------------------------------- */

describe('the admin endpoint reading', () => {
  it('reduces each observable outcome to its own closed reading', () => {
    expect(describeAdminReading(undefined)).toBe('not-attempted')
    expect(describeAdminReading({})).toBe('never-completed')
    expect(describeAdminReading({ payloadRead: true })).toBe('payload-read')
    expect(describeAdminReading({ status: 403 })).toBe('refused-403')
    expect(describeAdminReading({ status: 401 })).toBe('unauthenticated-401')
    expect(describeAdminReading({ status: 404 })).toBe('endpoint-missing-404')
    expect(describeAdminReading({ status: 500 })).toBe('answered-other')
  })

  it('prefers a payload over a stale failure held beside it', () => {
    expect(describeAdminReading({ payloadRead: true, status: 403 })).toBe('payload-read')
  })

  it('covers every declared reading, so a reading added later cannot be unmapped', () => {
    for (const reading of ADMIN_READINGS) {
      const model = buildAccountSection({
        observations: healthyObservations(),
        adminAccess:
          reading === 'not-attempted'
            ? undefined
            : reading === 'payload-read'
              ? { payloadRead: true }
              : reading === 'never-completed'
                ? {}
                : {
                    status:
                      reading === 'refused-403'
                        ? 403
                        : reading === 'unauthenticated-401'
                          ? 401
                          : reading === 'endpoint-missing-404'
                            ? 404
                            : 500,
                  },
      })

      expect(rowOf(model, 'Admin role, as the server answered').value).not.toBe('')
      expect(rowOf(model, 'A session the server accepts').value).not.toBe('')
    }
  })

  it('reads a 403 as a missing ROLE over a session that authenticated perfectly well', () => {
    const model = buildAccountSection({ observations: healthyObservations(), adminAccess: { status: 403 } })
    const role = rowOf(model, 'Admin role, as the server answered')
    const session = rowOf(model, 'A session the server accepts')

    expect({ value: String(role.value), verdict: role.verdict, kind: role.evidence.kind }).toEqual({
      value: 'refused by the server (403)',
      verdict: 'broken',
      kind: 'direct',
    })
    expect({ value: String(session.value), verdict: session.verdict, kind: session.evidence.kind }).toEqual({
      value: 'accepted (refused on the role, not on authentication)',
      verdict: 'healthy',
      kind: 'direct',
    })

    expect(codesOf(model)).toContain('ADMIN_ROLE_NOT_ON_SESSION')
    const finding = findingOf(model, 'ADMIN_ROLE_NOT_ON_SESSION')
    expect(finding?.verdict).toBe('broken')
    expect(finding?.remedy?.steps[0]).toContain('Sign out and back in')
    expect(EFFORT_LABEL[finding?.remedy?.effort ?? 'none']).toBe('On this device')
  })

  it('reads a 401 as a rejected SESSION and claims nothing at all about the role', () => {
    const model = buildAccountSection({ observations: healthyObservations(), adminAccess: { status: 401 } })
    const role = rowOf(model, 'Admin role, as the server answered')
    const session = rowOf(model, 'A session the server accepts')

    expect({ verdict: role.verdict, kind: role.evidence.kind }).toEqual({ verdict: 'undetermined', kind: 'absent' })
    expect(String(role.value)).toContain('not established')
    expect(String(role.value)).toContain('401')
    expect({ verdict: session.verdict, kind: session.evidence.kind }).toEqual({ verdict: 'broken', kind: 'direct' })
    expect(session.value).toBe('rejected (401)')

    // The role finding must NOT fire on a 401: the role check never ran, so
    // sending this operator to audit their roles is a guaranteed dead end.
    expect(codesOf(model)).not.toContain('ADMIN_ROLE_NOT_ON_SESSION')
  })

  it('does not infer anything about either requirement from a 404 or an unfinished request', () => {
    for (const access of [{ status: 404 }, { status: 500 }, {}, undefined]) {
      const model = buildAccountSection({ observations: healthyObservations(), adminAccess: access })

      for (const label of ['Admin role, as the server answered', 'A session the server accepts']) {
        const row = rowOf(model, label)
        expect({ label, verdict: row.verdict, kind: row.evidence.kind }).toEqual({
          label,
          verdict: 'undetermined',
          kind: 'absent',
        })
      }
      expect(codesOf(model)).not.toContain('ADMIN_ROLE_NOT_ON_SESSION')
    }
  })

  it('confirms the role and the session together when the payload was read', () => {
    const model = healthySection()

    expect(rowOf(model, 'Admin role, as the server answered').verdict).toBe('healthy')
    expect(rowOf(model, 'Admin role, as the server answered').evidence.kind).toBe('direct')
    expect(rowOf(model, 'A session the server accepts').verdict).toBe('healthy')
    expect(codesOf(model)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* 3. A proxy claim is capped, in both directions                             */
/* -------------------------------------------------------------------------- */

describe('the client-side admin claim', () => {
  it('caps a positive claim and says what the cap was for', () => {
    const row = rowOf(healthySection(), 'Admin role, as this client sees it')

    expect(row.value).toBe('believed held')
    expect(row.claimed).toBe('healthy')
    expect(row.verdict).toBe('undetermined')
    expect(row.tone).toBe('neutral')
    expect(row.evidence.kind).toBe('proxy')
    expect(row.caveat).toContain("this client's own cached role list")
    expect(row.caveat).toContain('does not establish')
  })

  it('caps the NEGATIVE claim too, because a correlated signal failing establishes nothing', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ clientBelievesAdmin: false }),
      adminAccess: { payloadRead: true },
    })
    const row = rowOf(model, 'Admin role, as this client sees it')

    expect(row.value).toBe('not believed held')
    expect(row.claimed).toBe('broken')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('proxy')
    // The "its failure is conclusive" sentence belongs to a NECESSARY condition
    // and must never reach this row.
    expect(row.caveat).not.toContain('Its failure is conclusive')
  })

  it('declares the relation as correlated rather than necessary', () => {
    const row = rowOf(healthySection(), 'Admin role, as this client sees it')

    expect(row.evidence.kind === 'proxy' ? row.evidence.relation : undefined).toBe('correlated')
  })
})

/* -------------------------------------------------------------------------- */
/* 4. Space: absent is not zero, and absent is not room                       */
/* -------------------------------------------------------------------------- */

describe('the account file allowance', () => {
  it('reduces bytes to whole binary megabytes, rounding down', () => {
    expect(wholeMegabytes(undefined)).toBeUndefined()
    expect(wholeMegabytes(-1)).toBeUndefined()
    expect(wholeMegabytes(0)).toBe(0)
    expect(wholeMegabytes(MB - 1)).toBe(0)
    expect(wholeMegabytes(5 * MB + 17)).toBe(5)
  })

  it('never divides by a limit it cannot use', () => {
    expect(fileQuotaFraction(10, undefined)).toBeUndefined()
    expect(fileQuotaFraction(10, 0)).toBeUndefined()
    expect(fileQuotaFraction(10, -1)).toBeUndefined()
    expect(fileQuotaFraction(undefined, 100)).toBeUndefined()
    expect(fileQuotaFraction(Number.NaN, 100)).toBeUndefined()
    expect(fileQuotaFraction(25, 100)).toBe(0.25)
  })

  it('separates unlimited, no allowance and the three headroom states', () => {
    expect(describeFileQuota(10, -1)).toBe('unlimited')
    expect(describeFileQuota(undefined, -1)).toBe('unlimited')
    expect(describeFileQuota(0, 0)).toBe('no-allowance')
    expect(describeFileQuota(10, 100)).toBe('room-available')
    expect(describeFileQuota(FILE_QUOTA_NEAR_FRACTION * 100, 100)).toBe('nearly-full')
    expect(describeFileQuota(100, 100)).toBe('exhausted')
    expect(describeFileQuota(140, 100)).toBe('exhausted')
  })

  it('returns NO state when the figures were not reported, rather than a flattering one', () => {
    expect(describeFileQuota(undefined, undefined)).toBeUndefined()
    expect(describeFileQuota(undefined, 100)).toBeUndefined()
    expect(describeFileQuota(10, undefined)).toBeUndefined()
  })

  it('does not read an unreported allowance as room available', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ fileUploadBytesUsed: undefined, fileUploadBytesLimit: undefined }),
    })
    const headroom = rowOf(model, 'Room for a file upload')

    expect({ value: String(headroom.value), verdict: headroom.verdict, kind: headroom.evidence.kind }).toEqual({
      value: 'not reported',
      verdict: 'undetermined',
      kind: 'absent',
    })
    expect(rowOf(model, 'Server file allowance used').value).toBe('not reported')
    expect(rowOf(model, 'Server file bytes used, whole MB').value).toBe('not reported')
    expect(codesOf(model)).not.toContain('ACCOUNT_FILE_QUOTA_NEARLY_FULL')
  })

  /* ------------------------------------------------------------------------ */
  /* Two kinds of empty, and they must never render the same                  */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THE MISREAD THIS PAIR EXISTS FOR. ***
   *
   * An all-"not reported" Space block was taken for cosmetic noise, and on the
   * deployment it was taken from it was the only trace in a whole diagnostics
   * report of a files subsystem that was completely broken — the operator's listing
   * aborted, downloads hung, usage read zero. "Nobody asked" and "the read failed"
   * are the same defect class as a collection answering `[]` for both "none" and
   * "not read yet", and they are kept apart here by a closed value rather than by
   * the reader's judgement.
   */
  const emptySpace = (
    source: AccountObservations['spaceFigureSource'],
    census?: AccountObservations['fileCensus'],
  ): SectionModel =>
    buildAccountSection({
      observations: healthyObservations({
        fileUploadBytesUsed: undefined,
        fileUploadBytesLimit: undefined,
        ...(source === undefined ? {} : { spaceFigureSource: source }),
        ...(census === undefined ? {} : { fileCensus: census }),
      }),
    })

  /**
   * *** THE CONTROL CASE. A THROWN READ IS STILL BROKEN. ***
   *
   * The three-way split below exists to stop a missing figure being rated as a
   * failure, and the way that goes wrong is by taking the failure with it. This
   * test is the proof it did not: it asserts `broken` on the one state that is a
   * real failure, and it asserts it against every arm of the new split — the
   * census is set to `none`, the arm that is deliberately the quietest, so a
   * mutation that let the census decide the verdict for a THROWN read would turn
   * this test red rather than passing on a technicality.
   */
  it('still reports a THROWN space read as broken, even for an account with no files at all', () => {
    const model = emptySpace('read-threw', 'none')

    // Preconditions, so none of this can go vacuous: the rows really are empty,
    // the source really is the thrown one, and the census really was read and
    // really says the quietest thing it can say.
    expect(rowOf(model, 'Server file allowance used').value).toBe('not reported')
    expect(rowOf(model, 'Server file bytes used, whole MB').value).toBe('not reported')
    expect(rowOf(model, 'Uploaded files in this account').value).toBe('none')

    expect(findingOf(model, 'ACCOUNT_SPACE_READ_FAILED')?.verdict).toBe('broken')
    expect(findingOf(model, 'ACCOUNT_SPACE_READ_FAILED')?.detail).toContain('read FAILED')
    expect(findingOf(model, 'ACCOUNT_SPACE_READ_FAILED')?.detail).toContain('No answer arrived at all')
    // *** AND IT DOES NOT ATTRIBUTE ITSELF TO THE FILES LANE. *** These figures are
    // per-account settings served by auth; a deployment whose transfers are entirely
    // broken reports them perfectly. The first draft of this finding said the
    // opposite, which would have pointed an operator at the wrong subsystem.
    expect(findingOf(model, 'ACCOUNT_SPACE_READ_FAILED')?.detail).toContain('not at the files service')
    expect(findingOf(model, 'ACCOUNT_SPACE_READ_FAILED')?.detail).toContain(
      'Do not read this as evidence about attachments',
    )
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_NOT_READ')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_NOTHING_TO_REPORT')
    expect(model.worstVerdict).toBe('broken')
  })

  it('reports a thrown read as broken whatever the census says, including with files present', () => {
    for (const census of ['present', 'none', 'not-loaded'] as const) {
      const model = emptySpace('read-threw', census)

      expect(rowOf(model, 'Uploaded files in this account').value).toBe(census)
      expect(findingOf(model, 'ACCOUNT_SPACE_READ_FAILED')?.verdict).toBe('broken')
      expect(model.worstVerdict).toBe('broken')
    }
  })

  /* ------------------------------------------------------------------------ */
  /* An ANSWER carrying no figure is three different things                   */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THE FALSE ALARM THIS SPLIT REMOVES, STATED AS ITS OWN TEST. ***
   *
   * A brand-new account that has simply never uploaded a file read `broken`, and
   * that is the decisive case: FILE_UPLOAD_BYTES_USED does not exist until an
   * upload succeeds, auth answers 400 for the missing row, and the client maps 400
   * to `undefined` WITHOUT throwing — so the commonest reading in the fleet was
   * rated as a broken deployment. The assertion is on the whole section's verdict,
   * not just the finding, because that single finding was what dragged the section.
   */
  it('reports an account that has simply never uploaded a file as informational, not broken', () => {
    const model = emptySpace('read-carried-no-figure', 'none')

    expect(rowOf(model, 'Server file allowance used').value).toBe('not reported')
    expect(rowOf(model, 'Uploaded files in this account').value).toBe('none')

    expect(findingOf(model, 'ACCOUNT_SPACE_NOTHING_TO_REPORT')?.verdict).toBe('informational')
    expect(findingOf(model, 'ACCOUNT_SPACE_NOTHING_TO_REPORT')?.detail).toContain('this account holds no file')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_READ_FAILED')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_USAGE_UNRECORDED')
    expect(model.worstVerdict).not.toBe('broken')
    expect(model.worstVerdict).not.toBe('degraded')
  })

  it('reports a missing figure for an account that HAS files as a degradation of the bookkeeping', () => {
    const model = emptySpace('read-carried-no-figure', 'present')

    expect(rowOf(model, 'Uploaded files in this account').value).toBe('present')
    expect(findingOf(model, 'ACCOUNT_SPACE_USAGE_UNRECORDED')?.verdict).toBe('degraded')
    expect(findingOf(model, 'ACCOUNT_SPACE_USAGE_UNRECORDED')?.detail).toContain('bookkeeping')
    // DIRECT: both halves of the claim are measured here — files exist, and the
    // answer carried no figure. The cause is capped in the detail, which is
    // asserted so the cap cannot be dropped silently.
    expect(findingOf(model, 'ACCOUNT_SPACE_USAGE_UNRECORDED')?.evidence.kind).toBe('direct')
    expect(findingOf(model, 'ACCOUNT_SPACE_USAGE_UNRECORDED')?.detail).toContain('is not established')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_NOTHING_TO_REPORT')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_READ_FAILED')
    expect(model.worstVerdict).toBe('degraded')
  })

  /**
   * *** AN UNLOADED COLLECTION IS NOT AN EMPTY ONE. ***
   *
   * `items` answers `[]` for the whole window between launch and the cold load
   * finishing, so reading that as "this account has no files" would report a real
   * loss of upload bookkeeping as "nothing to report" on every freshly opened app.
   * It gets its own state and its own verdict, and the verdict is NOT the quiet one.
   */
  it('claims neither answer while the item collection has not finished loading', () => {
    const model = emptySpace('read-carried-no-figure', 'not-loaded')

    expect(rowOf(model, 'Uploaded files in this account').value).toBe('not-loaded')
    expect(findingOf(model, 'ACCOUNT_SPACE_FIGURE_UNEXPLAINED')?.verdict).toBe('undetermined')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_NOTHING_TO_REPORT')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_USAGE_UNRECORDED')
  })

  it('claims neither answer when the caller reported no census at all', () => {
    const model = emptySpace('read-carried-no-figure')

    expect(rowOf(model, 'Uploaded files in this account').value).toBe('not reported')
    expect(findingOf(model, 'ACCOUNT_SPACE_FIGURE_UNEXPLAINED')?.verdict).toBe('undetermined')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_NOTHING_TO_REPORT')
  })

  it('refuses a census value outside its closed set rather than echoing it', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ fileCensus: 'plenty-of-them@somewhere.test' }),
    })

    expect(rowOf(model, 'Uploaded files in this account').value).toBe('other (unrecognised)')
  })

  it('reports an unattempted space read as the caller gap it is, not as a quiet deployment', () => {
    const model = emptySpace('not-attempted')

    expect(rowOf(model, 'Server file allowance used').value).toBe('not reported')
    expect(findingOf(model, 'ACCOUNT_SPACE_NOT_READ')?.verdict).toBe('undetermined')
    expect(findingOf(model, 'ACCOUNT_SPACE_NOT_READ')?.detail).toContain('a gap in the CALLER')
    expect(findingOf(model, 'ACCOUNT_SPACE_NOT_READ')?.detail).toContain('never as zero')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_READ_FAILED')
    // *** THE DISCRIMINATION. *** The two renderings must differ, and the one
    // that is a symptom is the only one with a verdict.
    expect(model.worstVerdict).not.toBe('broken')
  })

  it('claims neither kind of empty when the caller did not say which it is', () => {
    // Absent is not "nobody asked" either. A caller that supplied no source has not
    // told this block whether the read was attempted, and a block that guessed
    // would be making the absent-is-false mistake it exists to flag.
    const model = emptySpace(undefined)

    expect(rowOf(model, 'Server file allowance used').value).toBe('not reported')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_NOT_READ')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_READ_FAILED')
  })

  it('says nothing about the space source when the figures DID arrive', () => {
    for (const source of SPACE_FIGURE_SOURCES) {
      const model = buildAccountSection({ observations: healthyObservations({ spaceFigureSource: source }) })

      expect(rowOf(model, 'Server file allowance used').value).toBe('0-25%')
      expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_READ_FAILED')
      expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_NOT_READ')
      expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_USAGE_UNRECORDED')
      expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_NOTHING_TO_REPORT')
      expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_FIGURE_UNEXPLAINED')
    }
  })

  /**
   * The loop above is only worth anything if it covers every source. Iterating the
   * exported tuple rather than a hand-written list is what keeps it covering them:
   * a member added to the union and not to a literal array would leave the new
   * state untested while the suite stayed green.
   */
  it('covers every declared space-figure source in the loop above', () => {
    expect([...SPACE_FIGURE_SOURCES].sort()).toEqual(['not-attempted', 'read-carried-no-figure', 'read-threw'])
  })

  it('does not read an unreported used figure as zero', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ fileUploadBytesUsed: undefined }),
    })

    expect(rowOf(model, 'Server file bytes used, whole MB').value).toBe('not reported')
    expect(rowOf(model, 'Server file bytes used, whole MB').value).not.toBe('0')
    expect(rowOf(model, 'Room for a file upload').verdict).toBe('undetermined')
  })

  it('reports a measured zero as a zero', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ fileUploadBytesUsed: 0, fileUploadBytesLimit: 1000 * MB }),
    })

    expect(rowOf(model, 'Server file bytes used, whole MB').value).toBe('0')
    expect(rowOf(model, 'Server file allowance used').value).toBe('0-25%')
    expect(rowOf(model, 'Room for a file upload').verdict).toBe('healthy')
  })

  it('prints the unlimited sentinel rather than a negative byte count', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ fileUploadBytesLimit: -1 }),
    })

    expect(rowOf(model, 'Server file allowance, whole MB').value).toBe('no limit set')
    expect(rowOf(model, 'Server file allowance used').value).toBe('no limit set')
    expect(rowOf(model, 'Room for a file upload').value).toBe('no limit set')
    expect(rowOf(model, 'Room for a file upload').verdict).toBe('healthy')
  })

  it('treats an allowance of nothing as broken rather than as an absent limit', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ fileUploadBytesLimit: 0, fileUploadBytesUsed: 0 }),
    })
    const headroom = rowOf(model, 'Room for a file upload')

    expect(headroom.value).toBe('no allowance granted')
    expect(headroom.verdict).toBe('broken')
    expect(headroom.evidence.kind).toBe('direct')
    expect(findingOf(model, 'ACCOUNT_FILE_QUOTA_NEARLY_FULL')?.verdict).toBe('broken')
  })

  it('warns before the first refused upload, and says writes still work', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ fileUploadBytesUsed: 950 * MB, fileUploadBytesLimit: 1000 * MB }),
    })
    const finding = findingOf(model, 'ACCOUNT_FILE_QUOTA_NEARLY_FULL')

    expect(rowOf(model, 'Room for a file upload').verdict).toBe('degraded')
    expect(rowOf(model, 'Server file allowance used').value).toBe('90-100%')
    expect(finding?.verdict).toBe('degraded')
    expect(finding?.detail).toContain('nothing is failing yet')
    expect(finding?.remedy?.summary).toContain('close to its server file allowance')
    expect(finding?.remedy?.steps.join(' ')).toContain('-1 is the only value the files server treats as unlimited')
  })

  it('branches the exhausted arm onto a different detail and a different remedy', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ fileUploadBytesUsed: 1200 * MB, fileUploadBytesLimit: 1000 * MB }),
    })
    const finding = findingOf(model, 'ACCOUNT_FILE_QUOTA_NEARLY_FULL')

    expect(rowOf(model, 'Server file allowance used').value).toBe('over 100%')
    expect(rowOf(model, 'Room for a file upload').verdict).toBe('broken')
    expect(finding?.verdict).toBe('broken')
    expect(finding?.detail).toContain('refused at the server')
    expect(finding?.remedy?.summary).toContain('refuses new uploads')
    expect(finding?.remedy?.because.join(' ')).toContain('at or above the reported limit')
  })

  it('keeps the user’s own soft cap advisory, with no tone even when it is exceeded', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ localSoftCapBytes: 10 * MB, localUsageBytes: 900 * MB }),
    })
    const row = rowOf(model, 'Local usage against the soft cap')

    expect(row.value).toBe('over the cap')
    expect(row.verdict).toBe('informational')
    expect(row.note).toContain('NEVER blocks a save or a sync')
    expect(rowOf(model, 'Local usage soft cap').value).toBe('set')
    expect(codesOf(model)).toEqual([])
  })

  it('reads a zero soft cap as no cap rather than as a cap of zero', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ localSoftCapBytes: 0, localUsageBytes: 900 * MB }),
    })

    expect(rowOf(model, 'Local usage soft cap').value).toBe('no cap')
    expect(rowOf(model, 'Local usage against the soft cap').value).toBe('not reported')
    expect(rowOf(model, 'Local usage against the soft cap').evidence.kind).toBe('absent')
  })

  /* ------------------------------------------------------------------------ */
  /* The EFFECTIVE allowance, and the arm it must not silence                 */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THE REGRESSION THIS WHOLE GROUP EXISTS TO PREVENT. ***
   *
   * The server now derives the EFFECTIVE file allowance when no per-account limit
   * row exists, because an absent limit was never an absent allowance — the
   * upload-token minter falls back to the plan default, and to unlimited where
   * there is no live subscription. That change publishes a figure on deployments
   * that previously published none, and the Space block's findings used to be
   * gated on BOTH figures being absent.
   *
   * So the one new number would have silenced every arm below, including
   * `ACCOUNT_SPACE_USAGE_UNRECORDED` — whose entire subject is a USAGE total
   * nobody is keeping. A finding that is present, wired and incapable of firing is
   * worse than one that was never written, because the screen then reads as proof
   * that nothing is wrong.
   *
   * This test is the proof the arm survived: the allowance ARRIVED, the usage did
   * not, the account holds files, and the degradation is still reported.
   */
  it('still reports the lost usage bookkeeping when the effective allowance DID arrive', () => {
    const model = buildAccountSection({
      observations: healthyObservations({
        fileUploadBytesUsed: undefined,
        fileUploadBytesLimit: -1,
        fileAllowanceOrigin: 'no-active-subscription',
        spaceFigureSource: 'read-carried-no-figure',
        fileCensus: 'present',
      }),
    })

    // Preconditions, so this cannot pass vacuously: one figure really did arrive
    // and the other really did not.
    expect(rowOf(model, 'Server file allowance, whole MB').value).toBe('no limit set')
    expect(rowOf(model, 'Server file bytes used, whole MB').value).toBe('not reported')

    expect(findingOf(model, 'ACCOUNT_SPACE_USAGE_UNRECORDED')?.verdict).toBe('degraded')
    expect(model.worstVerdict).toBe('degraded')
    // And the allowance arm does NOT also fire: one defect, one finding.
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_ALLOWANCE_UNREPORTED')
  })

  /**
   * The same guard for the two quieter arms, because silencing those would hide a
   * brand-new account's explanation rather than a degradation — still a row of
   * "not reported" with nothing on the screen saying why.
   */
  it.each([
    ['none', 'ACCOUNT_SPACE_NOTHING_TO_REPORT'],
    ['not-loaded', 'ACCOUNT_SPACE_FIGURE_UNEXPLAINED'],
  ] as const)('keeps the %s arm reachable once the allowance is published', (census, code) => {
    const model = buildAccountSection({
      observations: healthyObservations({
        fileUploadBytesUsed: undefined,
        fileUploadBytesLimit: 1000 * MB,
        fileAllowanceOrigin: 'plan-default',
        spaceFigureSource: 'read-carried-no-figure',
        fileCensus: census,
      }),
    })

    expect(rowOf(model, 'Server file allowance, whole MB').value).toBe('1000')
    expect(codesOf(model)).toContain(code)
  })

  /**
   * *** AND A THROWN READ IS STILL BROKEN WHEN ONLY ONE FIGURE SURVIVED IT. ***
   *
   * The two settings are read independently, so one can reject while the other
   * answers. Keyed on both figures being absent, that state reported NOTHING at
   * all — a failed read with no finding, which is the quietest possible way to
   * lose a real failure.
   */
  it('reports a thrown read as broken even when the other figure arrived', () => {
    const model = buildAccountSection({
      observations: healthyObservations({
        fileUploadBytesUsed: undefined,
        fileUploadBytesLimit: -1,
        spaceFigureSource: 'read-threw',
        fileCensus: 'present',
      }),
    })

    expect(rowOf(model, 'Server file allowance, whole MB').value).toBe('no limit set')
    expect(findingOf(model, 'ACCOUNT_SPACE_READ_FAILED')?.verdict).toBe('broken')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_USAGE_UNRECORDED')
  })

  /**
   * THE HEADROOM ROW IS NOW DERIVABLE, which is the operator-visible point of the
   * server change: "Room for a file upload" read "not reported" on every
   * deployment that had never written a limit setting, which was every default
   * one. An unlimited effective allowance resolves it with no usage figure at all,
   * because nothing is refused at an unlimited ceiling whatever the total is.
   */
  it('resolves the upload-headroom verdict from an effective unlimited allowance alone', () => {
    const model = buildAccountSection({
      observations: healthyObservations({
        fileUploadBytesUsed: undefined,
        fileUploadBytesLimit: -1,
        fileAllowanceOrigin: 'no-active-subscription',
        spaceFigureSource: 'read-carried-no-figure',
        fileCensus: 'present',
      }),
    })
    const headroom = rowOf(model, 'Room for a file upload')

    expect({ value: String(headroom.value), verdict: headroom.verdict, kind: headroom.evidence.kind }).toEqual({
      value: 'no limit set',
      verdict: 'healthy',
      kind: 'direct',
    })
  })

  it('reports where the allowance came from, as a closed server enum', () => {
    for (const origin of FILE_ALLOWANCE_ORIGINS) {
      const model = buildAccountSection({
        observations: healthyObservations({ fileUploadBytesLimit: 1000 * MB, fileAllowanceOrigin: origin }),
      })
      const row = rowOf(model, 'Where the file allowance comes from')

      expect({ origin, value: String(row.value), verdict: row.verdict, kind: row.evidence.kind }).toEqual({
        origin,
        value: origin,
        verdict: 'informational',
        kind: 'direct',
      })
    }
  })

  it('covers every declared allowance origin in the loop above', () => {
    expect([...FILE_ALLOWANCE_ORIGINS].sort()).toEqual(['account-setting', 'no-active-subscription', 'plan-default'])
  })

  it('refuses an allowance origin outside its closed set rather than echoing it', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ fileAllowanceOrigin: 'because-someone@somewhere.test' }),
    })

    expect(rowOf(model, 'Where the file allowance comes from').value).toBe('other (unrecognised)')
  })

  /**
   * *** AN UNREPORTED PROVENANCE IS NOT "THE PLAN DEFAULT". ***
   *
   * Every server built before the effective-allowance answer sends a value with no
   * origin, and the flattering reading — "no origin means nothing was set, so it
   * must be the default" — would invent a fact about a deployment nobody asked.
   */
  it('does not read a missing allowance origin as any particular origin', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ fileUploadBytesLimit: 1000 * MB }),
    })
    const row = rowOf(model, 'Where the file allowance comes from')

    expect({ value: String(row.value), verdict: row.verdict, kind: row.evidence.kind }).toEqual({
      value: 'not reported',
      verdict: 'undetermined',
      kind: 'absent',
    })
    expect(rowOf(model, 'Server file allowance, whole MB').value).toBe('1000')
  })

  /**
   * THE SERVER THAT IS TOO OLD TO DERIVE AN ALLOWANCE gets its own arm, and it is
   * `undetermined` rather than a fault: nothing is refused by it, and what is lost
   * is only the headroom verdict.
   */
  it('reports a usage total with no allowance as an unanswered allowance, not as a fault', () => {
    const model = buildAccountSection({
      observations: healthyObservations({
        fileUploadBytesUsed: 100 * MB,
        fileUploadBytesLimit: undefined,
        spaceFigureSource: 'read-carried-no-figure',
        fileCensus: 'present',
      }),
    })

    expect(rowOf(model, 'Server file bytes used, whole MB').value).toBe('100')
    expect(rowOf(model, 'Server file allowance, whole MB').value).toBe('not reported')
    expect(findingOf(model, 'ACCOUNT_SPACE_ALLOWANCE_UNREPORTED')?.verdict).toBe('undetermined')
    expect(findingOf(model, 'ACCOUNT_SPACE_ALLOWANCE_UNREPORTED')?.evidence.kind).toBe('absent')
    expect(findingOf(model, 'ACCOUNT_SPACE_ALLOWANCE_UNREPORTED')?.detail).toContain('plan default')
    // Mutually exclusive with every usage arm, so a reader still counts one
    // problem per problem.
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_USAGE_UNRECORDED')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_NOTHING_TO_REPORT')
    expect(codesOf(model)).not.toContain('ACCOUNT_SPACE_FIGURE_UNEXPLAINED')
    expect(rowOf(model, 'Room for a file upload').verdict).toBe('undetermined')
  })

  /**
   * *** ONE DEFECT, ONE FINDING, OVER THE WHOLE CROSS PRODUCT. ***
   *
   * Five arms now key on three different conditions, and the cheap way to get that
   * wrong is to have two of them fire at once — which reads on the screen as two
   * problems and sends an operator chasing the second one. Swept rather than
   * spot-checked: every space-figure source, every census, both usage states and
   * all three allowance states.
   */
  it('emits at most one Space finding whatever the two figures and the census say', () => {
    const spaceCodes = [
      'ACCOUNT_SPACE_READ_FAILED',
      'ACCOUNT_SPACE_USAGE_UNRECORDED',
      'ACCOUNT_SPACE_NOTHING_TO_REPORT',
      'ACCOUNT_SPACE_FIGURE_UNEXPLAINED',
      'ACCOUNT_SPACE_ALLOWANCE_UNREPORTED',
      'ACCOUNT_SPACE_NOT_READ',
    ]

    for (const source of SPACE_FIGURE_SOURCES) {
      for (const census of ['present', 'none', 'not-loaded', undefined] as const) {
        for (const used of [undefined, 100 * MB] as const) {
          for (const limit of [undefined, -1, 1000 * MB] as const) {
            const model = buildAccountSection({
              observations: healthyObservations({
                fileUploadBytesUsed: used,
                fileUploadBytesLimit: limit,
                spaceFigureSource: source,
                ...(census === undefined ? {} : { fileCensus: census }),
              }),
            })
            const fired = codesOf(model).filter((code) => spaceCodes.includes(code))

            expect({ source, census, used, limit, count: fired.length }).toEqual({
              source,
              census,
              used,
              limit,
              count: Math.min(fired.length, 1),
            })
          }
        }
      }
    }
  })

  it('carries no verdict anywhere in the Space block, because the verdict is a requirement row', () => {
    const space = healthySection().blocks.find((block) => String(block.heading) === 'Space')

    expect(space?.rows.length).toBe(7)
    for (const row of space?.rows ?? []) {
      // Two Space rows can be absent on a healthy model — `healthyObservations`
      // supplies neither `fileCensus` nor `fileAllowanceOrigin` — and `absentOr`
      // claims nothing at all for an absent field rather than claiming the tone
      // it would carry if present. Still no row here claims a verdict, which is
      // what this test is about; those two claim less, not more.
      if (
        String(row.label) === 'Uploaded files in this account' ||
        String(row.label) === 'Where the file allowance comes from'
      ) {
        expect({ label: String(row.label), claimed: row.claimed, verdict: row.verdict }).toEqual({
          label: String(row.label),
          claimed: 'undetermined',
          verdict: 'undetermined',
        })
        continue
      }
      expect({ label: String(row.label), verdict: row.verdict }).toEqual({
        label: String(row.label),
        verdict: 'informational',
      })
    }
    expect(space?.findings).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* 5. The requirements block: every row names what breaks                     */
/* -------------------------------------------------------------------------- */

describe('the general requirements block', () => {
  const requirements = (model: SectionModel) =>
    model.blocks.find((block) => String(block.heading) === 'General requirements to be working')

  it('holds the seven requirements and each row says what breaks', () => {
    const block = requirements(healthySection())

    expect(block?.rows.map((row) => String(row.label))).toEqual([
      'A session the server accepts',
      'Room for a file upload',
      'Live sync for this account',
      'Collaboration permitted for this account',
      'Shared vaults offered by this client',
      'Operations this client cannot consume',
      'Server sync protocol version',
    ])

    // A row that cannot say what breaks does not belong, so every row either
    // names a consequence or explicitly says it carries none.
    for (const row of block?.rows ?? []) {
      const note = row.note
      const namesAConsequence =
        note.includes('What breaks') ||
        note.includes('What it costs') ||
        note.includes('breaks when') ||
        note.includes('nothing more')
      expect({ label: String(row.label), namesAConsequence }).toEqual({
        label: String(row.label),
        namesAConsequence: true,
      })
    }
  })

  it('reports a signed-out client as broken, with the local fact kept separate from the server one', () => {
    const model = buildAccountSection({ observations: healthyObservations({ signedIn: false }) })

    expect(rowOf(model, 'Signed in').verdict).toBe('broken')
    expect(rowOf(model, 'Signed in').value).toBe('signed out')
    expect(rowOf(model, 'A session the server accepts').verdict).toBe('undetermined')
    expect(findingOf(model, 'ACCOUNT_SIGNED_OUT')?.remedy?.effort).toBe('device')
    expect(findingOf(model, 'ACCOUNT_SIGNED_OUT')?.detail).toContain('Nothing syncs')
  })

  it('does not fire the signed-out finding when nobody said whether this client is signed in', () => {
    const model = buildAccountSection({ observations: healthyObservations({ signedIn: undefined }) })

    expect(rowOf(model, 'Signed in').value).toBe('not reported')
    expect(rowOf(model, 'Signed in').verdict).toBe('undetermined')
    expect(codesOf(model)).not.toContain('ACCOUNT_SIGNED_OUT')
  })

  it('reads a live-sync refusal on the transport as this ACCOUNT being switched off', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ fallbackReason: 'live-sync-disabled' }),
    })
    const row = rowOf(model, 'Live sync for this account')
    const finding = findingOf(model, 'ACCOUNT_LIVE_SYNC_DISABLED')

    expect(row.value).toBe('disabled (refused on the sync lane)')
    expect(row.verdict).toBe('broken')
    expect(row.evidence.kind).toBe('direct')
    expect(finding?.verdict).toBe('broken')
    expect(finding?.detail).toContain('Admin → Users → Live sync (LIVE_SYNC_ENABLED)')
    // No remedy chip on purpose: none of the seven efforts describes a
    // per-account switch, and a wrong chip is worse than none.
    expect(finding?.remedy).toBeUndefined()
  })

  it('claims nothing about the account switch from any OTHER fallback reason', () => {
    for (const reason of ['ticket-expired', 'unsupported-browser', 'outbox-unavailable'] as const) {
      const model = buildAccountSection({ observations: healthyObservations({ fallbackReason: reason }) })
      const row = rowOf(model, 'Live sync for this account')

      expect({ reason, value: String(row.value), verdict: row.verdict, kind: row.evidence.kind }).toEqual({
        reason,
        value: 'no endpoint publishes this',
        verdict: 'undetermined',
        kind: 'absent',
      })
      expect(codesOf(model)).not.toContain('ACCOUNT_LIVE_SYNC_DISABLED')
    }
  })

  it('prefers a reported per-account flag over the refusal code once a server sends one', () => {
    const enabled = buildAccountSection({ observations: healthyObservations({ liveSyncEnabledForAccount: true }) })
    const disabled = buildAccountSection({ observations: healthyObservations({ liveSyncEnabledForAccount: false }) })

    expect(rowOf(enabled, 'Live sync for this account').value).toBe('enabled')
    expect(rowOf(enabled, 'Live sync for this account').verdict).toBe('healthy')
    expect(rowOf(disabled, 'Live sync for this account').value).toBe('disabled')
    expect(codesOf(disabled)).toContain('ACCOUNT_LIVE_SYNC_DISABLED')
  })

  it('asks for the collaboration flag and reads "not reported" until a server sends it', () => {
    const asked = rowOf(healthySection(), 'Collaboration permitted for this account')

    // The VALUE says plainly that nothing produces it, rather than "not reported",
    // which reads as a check that failed. The verdict and the evidence are
    // unchanged — the row still claims nothing — and both are asserted here so the
    // wording change cannot be mistaken for the row having started to claim.
    expect(asked.value).toBe('no endpoint publishes this')
    expect(asked.value).not.toBe('not reported')
    expect(asked.verdict).toBe('undetermined')
    expect(asked.evidence.kind).toBe('absent')
    expect(asked.note).toContain('asked for and not yet sent')

    const off = buildAccountSection({
      observations: healthyObservations({ collaborationEnabledForAccount: false }),
    })
    expect(rowOf(off, 'Collaboration permitted for this account').verdict).toBe('broken')
  })

  it('keeps the client-side shared-vault gate informational, so a healthy account is not alarmed', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ entitledToSharedVaults: false }),
    })
    const row = rowOf(model, 'Shared vaults offered by this client')

    expect(row.value).toBe('not entitled')
    expect(row.verdict).toBe('informational')
    expect(row.evidence.kind).toBe('direct')
    expect(row.note).toContain('What it costs')
    expect(codesOf(model)).toEqual([])
  })

  it('counts the operations this build cannot consume against both of its own lists', () => {
    expect(unconsumableOperationCount(undefined)).toBeUndefined()
    expect(unconsumableOperationCount([])).toBe(0)
    expect(unconsumableOperationCount([...SUBSCRIPTION_PLANS])).toBe(3)

    for (const operation of ['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION', 'API_RPC', 'FILES_V1', 'INVITE_EVENTS']) {
      expect(unconsumableOperationCount([operation])).toBe(0)
    }
  })

  it('reports a clean operation list as healthy on direct evidence', () => {
    const row = rowOf(healthySection(), 'Operations this client cannot consume')

    expect(row.value).toBe('0')
    expect(row.verdict).toBe('healthy')
    expect(row.evidence.kind).toBe('direct')
  })

  it('does not read an unreported operation list as zero', () => {
    const model = buildAccountSection({ observations: healthyObservations({ serverOperations: undefined }) })
    const row = rowOf(model, 'Operations this client cannot consume')

    expect(row.value).toBe('not reported')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
    expect(codesOf(model)).not.toContain('CLIENT_GAP')
  })
})

/* -------------------------------------------------------------------------- */
/* 6. Roles and subscription as closed states                                 */
/* -------------------------------------------------------------------------- */

describe('roles and subscription', () => {
  it('reports one row per canonical role, held or not', () => {
    const model = buildAccountSection({ observations: healthyObservations({ roles: ['CORE_USER'] }) })

    expect(rowOf(model, 'Role: Core user').value).toBe('held')
    expect(rowOf(model, 'Role: Admin user').value).toBe('not held')
    expect(rowOf(model, 'Role: Full user').value).toBe('not held')
    expect(rowOf(model, 'Role: Vaults user').value).toBe('not held')
    expect(rowOf(model, UNRECOGNISED_ROLES_LABEL).value).toBe('0')
    expect(ACCOUNT_ROLES).toHaveLength(4)
  })

  it('does not read an unreported role list as "no roles"', () => {
    const model = buildAccountSection({ observations: healthyObservations({ roles: undefined }) })
    const labels = allRows(model).map((row) => String(row.label))

    expect(unrecognisedRoleCount(undefined)).toBeUndefined()
    // The per-role rows are not rendered at all rather than rendered as four
    // "not reported" ones, and the collapsed row that replaces them says why
    // instead of reading like a failed read. Neither renders as "not held".
    for (const label of ['Role: Admin user', 'Role: Full user', 'Role: Core user', 'Role: Vaults user']) {
      expect(labels).not.toContain(label)
    }
    expect(labels).not.toContain(UNRECOGNISED_ROLES_LABEL)

    const collapsed = rowOf(model, 'Roles held by this account')
    expect({ value: String(collapsed.value), kind: collapsed.evidence.kind, verdict: collapsed.verdict }).toEqual({
      value: 'not exposed by any client surface',
      kind: 'absent',
      verdict: 'undetermined',
    })
  })

  it('separates the five subscription states', () => {
    expect(describeSubscription({})).toBeUndefined()
    expect(describeSubscription({ subscriptionPresent: false })).toBe('none')
    expect(describeSubscription({ subscriptionPresent: false, offlineSubscription: true })).toBe('offline-only')
    expect(describeSubscription({ offlineSubscription: true })).toBe('offline-only')
    expect(describeSubscription({ subscriptionPresent: true })).toBe('active')
    expect(describeSubscription({ subscriptionPresent: true, subscriptionCancelled: true })).toBe('cancelled-until-end')
    expect(describeSubscription({ subscriptionPresent: true, subscriptionEndsInSeconds: 0 })).toBe('expired')
    expect(
      describeSubscription({ subscriptionPresent: true, subscriptionCancelled: true, subscriptionEndsInSeconds: -5 }),
    ).toBe('expired')
  })

  it('does not treat "no subscription" as a fault on a single-tier fork', () => {
    const model = buildAccountSection({
      observations: healthyObservations({
        subscriptionPresent: false,
        subscriptionPlan: undefined,
        subscriptionEndsInSeconds: undefined,
      }),
    })
    const row = rowOf(model, 'Subscription')

    expect(row.value).toBe('none')
    expect(row.verdict).toBe('informational')
    expect(row.note).toContain('not a fault')
    expect(rowOf(model, 'Subscription plan').value).toBe('not reported')
    expect(rowOf(model, 'Time until the subscription ends').value).toBe('not reported')
  })

  it('reports an ended subscription as degraded and prints no date', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ subscriptionEndsInSeconds: -1 }),
    })

    expect(rowOf(model, 'Subscription').value).toBe('ended')
    expect(rowOf(model, 'Subscription').verdict).toBe('degraded')
    expect(rowOf(model, 'Time until the subscription ends').value).toBe('already ended')
  })

  it('prints the remaining time as a duration, never an instant', () => {
    const model = buildAccountSection({
      observations: healthyObservations({ subscriptionEndsInSeconds: 90_000 }),
    })

    expect(rowOf(model, 'Time until the subscription ends').value).toBe('1d 1h')
    expect(healthySection().reportLines.join('\n')).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})

/* -------------------------------------------------------------------------- */
/* 7. Absent is not false, over every row at once                             */
/* -------------------------------------------------------------------------- */

describe('buildAccountSection with nothing observed', () => {
  it('claims absent evidence and no verdict for every row that is not a reading', () => {
    const model = buildAccountSection()
    const rows = allRows(model)

    expect(rows).toHaveLength(22)
    for (const row of rows) {
      expect({ label: String(row.label), kind: row.evidence.kind, verdict: row.verdict }).toEqual({
        label: String(row.label),
        kind: 'absent',
        verdict: 'undetermined',
      })
    }
    expect(codesOf(model)).toEqual([])
    expect(model.worstVerdict).toBe('undetermined')
    expect(model.headline).toBeUndefined()
  })

  it('reads "not reported" rather than a negative answer', () => {
    const model = buildAccountSection()

    for (const label of [
      'Signed in',
      'First-party server',
      'Admin role, as this client sees it',
      'Admin role, as the server answered',
      'Subscription',
      'Server file allowance used',
      'Room for a file upload',
      'Uploaded files in this account',
      'A session the server accepts',
    ]) {
      expect({ label, value: String(rowOf(model, label).value) }).toEqual({ label, value: 'not reported' })
    }
  })

  /**
   * *** "not reported" AND "nothing produces this" ARE DIFFERENT ANSWERS. ***
   *
   * The rows above describe facts that could have arrived and did not, and "not
   * reported" is the honest word for them. The rows below describe fields NOTHING
   * in the system emits, and rendering those as "not reported" sent an operator
   * looking for a defect in a pane that was working — which is the complaint this
   * distinction answers. Both halves are asserted, because a build that printed
   * the structural wording everywhere would be the same mistake inverted.
   */
  it('says plainly where no producer exists, rather than reusing "not reported"', () => {
    const model = buildAccountSection()

    for (const label of [
      'Roles held by this account',
      'Live sync for this account',
      'Collaboration permitted for this account',
    ]) {
      expect({ label, value: String(rowOf(model, label).value) }).not.toEqual({ label, value: 'not reported' })
    }

    expect(String(rowOf(model, 'Live sync for this account').value)).toBe('no endpoint publishes this')
    expect(String(rowOf(model, 'Collaboration permitted for this account').value)).toBe('no endpoint publishes this')
    expect(String(rowOf(model, 'Roles held by this account').value)).toBe('not exposed by any client surface')
  })

  it('builds the three blocks it always builds, in order, and names itself once', () => {
    const model = buildAccountSection()

    expect(model.id).toBe('account')
    expect(model.title).toBe('Account, space & requirements')
    expect(model.blocks.map((block) => String(block.heading))).toEqual([
      'Account and access',
      'Space',
      'General requirements to be working',
    ])
  })

  it('shows only the probe results tagged for this section, and only when there are some', () => {
    const none = buildAccountSection({
      outcomes: [{ name: 'Ticket mint', passed: true, detail: 'd', reportDetail: 'r', section: 'websocket' }],
    })
    const some = buildAccountSection({
      outcomes: [
        { name: 'Ticket mint', passed: true, detail: 'd', reportDetail: 'r', section: 'websocket' },
        { name: 'Authenticated round trip', passed: true, detail: 'd', reportDetail: 'r', section: 'account' },
      ],
    })

    expect(none.blocks.map((block) => String(block.heading))).not.toContain('Operator-triggered checks')
    const checks = some.blocks.find((block) => String(block.heading) === 'Operator-triggered checks')
    expect(checks?.outcomes).toHaveLength(1)
    expect(checks?.outcomes?.[0]?.name).toBe('Authenticated round trip')
  })
})
