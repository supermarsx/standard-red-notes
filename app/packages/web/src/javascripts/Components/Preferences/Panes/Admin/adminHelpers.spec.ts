import {
  ADMIN_USERS_DEFAULT_PAGE_SIZE,
  ADMIN_USERS_MAX_LIMIT,
  adminUsersFiltersAreEmpty,
  buildAdminListUsersParams,
  dateBoundToISO,
  emptyAdminUsersFilterState,
  formatAdminUserDate,
  formatAdminUserRoles,
  formatAdminUserStorage,
  formatAdminUserSubscription,
  formatBytes,
  formatLogTimestamp,
  logLevelColorClass,
  logMatchesText,
  serviceStatusChipClass,
  serviceStatusLabel,
  type AdminUsersFilterState,
  type LogEntry,
} from './adminHelpers'

describe('buildAdminListUsersParams', () => {
  const base = emptyAdminUsersFilterState()

  it('defaults to newest-first with a derived offset', () => {
    const params = buildAdminListUsersParams(base, 0, 100)
    expect(params).toEqual({ limit: 100, offset: 0, sort: '-createdAt' })
  })

  it('derives the offset from the zero-based page and page size', () => {
    expect(buildAdminListUsersParams(base, 3, 100).offset).toBe(300)
    expect(buildAdminListUsersParams(base, 2, 50).offset).toBe(100)
  })

  it('clamps the page size to the server cap and floors bad input', () => {
    expect(buildAdminListUsersParams(base, 0, 99999).limit).toBe(ADMIN_USERS_MAX_LIMIT)
    expect(buildAdminListUsersParams(base, 0, 0).limit).toBe(ADMIN_USERS_DEFAULT_PAGE_SIZE)
    expect(buildAdminListUsersParams(base, 0, -5).limit).toBe(1)
  })

  it('never produces a negative offset', () => {
    expect(buildAdminListUsersParams(base, -2, 100).offset).toBe(0)
  })

  it('omits empty filters entirely', () => {
    const params = buildAdminListUsersParams({ ...base, email: '   ' }, 0, 100)
    expect(params.email).toBeUndefined()
    expect(params.role).toBeUndefined()
    expect(params.banned).toBeUndefined()
    expect(params.subscription).toBeUndefined()
    expect(params.createdAfter).toBeUndefined()
    expect(params.createdBefore).toBeUndefined()
  })

  it('includes the trimmed email search when present', () => {
    expect(buildAdminListUsersParams({ ...base, email: '  a@b.com ' }, 0, 100).email).toBe('a@b.com')
  })

  it('maps the banned dropdown to a boolean, keeping "no" as false', () => {
    expect(buildAdminListUsersParams({ ...base, banned: 'yes' }, 0, 100).banned).toBe(true)
    expect(buildAdminListUsersParams({ ...base, banned: 'no' }, 0, 100).banned).toBe(false)
    expect(buildAdminListUsersParams({ ...base, banned: 'any' }, 0, 100).banned).toBeUndefined()
  })

  it('passes subscription and role through only when set', () => {
    const filters: AdminUsersFilterState = { ...base, subscription: 'active', role: 'ADMIN' }
    const params = buildAdminListUsersParams(filters, 0, 100)
    expect(params.subscription).toBe('active')
    expect(params.role).toBe('ADMIN')
  })

  it('converts date bounds to ISO instants (start vs inclusive end of day)', () => {
    const params = buildAdminListUsersParams(
      { ...base, createdAfter: '2026-01-01', createdBefore: '2026-01-31' },
      0,
      100,
    )
    expect(params.createdAfter).toBe('2026-01-01T00:00:00.000Z')
    expect(params.createdBefore).toBe('2026-01-31T23:59:59.999Z')
  })
})

describe('dateBoundToISO', () => {
  it('returns undefined for empty or invalid input', () => {
    expect(dateBoundToISO('', false)).toBeUndefined()
    expect(dateBoundToISO('not-a-date', false)).toBeUndefined()
  })
  it('uses start of day vs end of day', () => {
    expect(dateBoundToISO('2026-06-15', false)).toBe('2026-06-15T00:00:00.000Z')
    expect(dateBoundToISO('2026-06-15', true)).toBe('2026-06-15T23:59:59.999Z')
  })
})

describe('adminUsersFiltersAreEmpty', () => {
  it('is true for the empty state and false once any filter is set', () => {
    expect(adminUsersFiltersAreEmpty(emptyAdminUsersFilterState())).toBe(true)
    expect(adminUsersFiltersAreEmpty({ ...emptyAdminUsersFilterState(), email: 'x' })).toBe(false)
    expect(adminUsersFiltersAreEmpty({ ...emptyAdminUsersFilterState(), banned: 'yes' })).toBe(false)
  })
})

describe('user row formatting', () => {
  it('formats subscription cells', () => {
    expect(formatAdminUserSubscription(null)).toBe('None')
    expect(formatAdminUserSubscription({ plan: 'PRO_PLAN', active: true })).toBe('PRO_PLAN (active)')
    expect(formatAdminUserSubscription({ plan: 'PRO_PLAN', active: false })).toBe('PRO_PLAN (inactive)')
    expect(formatAdminUserSubscription({ plan: null, active: true })).toBe('Unknown plan (active)')
  })

  it('formats roles', () => {
    expect(formatAdminUserRoles([])).toBe('—')
    expect(formatAdminUserRoles(undefined)).toBe('—')
    expect(formatAdminUserRoles(['A', 'B'])).toBe('A, B')
  })

  it('formats a created date, passing through unparseable values', () => {
    expect(formatAdminUserDate(null)).toBe('—')
    expect(formatAdminUserDate('garbage')).toBe('garbage')
    expect(formatAdminUserDate('2026-01-01T00:00:00.000Z')).not.toBe('—')
  })
})

describe('formatBytes / formatAdminUserStorage', () => {
  it('formats byte magnitudes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
  })

  it('treats -1 or null limit as Unlimited and null used as Unknown', () => {
    expect(formatAdminUserStorage(1024, -1)).toBe('1 KB / Unlimited')
    expect(formatAdminUserStorage(1024, null)).toBe('1 KB / Unlimited')
    expect(formatAdminUserStorage(null, 1024)).toBe('Unknown / 1 KB')
    expect(formatAdminUserStorage(2048, 4096)).toBe('2 KB / 4 KB')
  })
})

describe('service status chips', () => {
  it('maps each status to a colour class, defaulting to neutral', () => {
    expect(serviceStatusChipClass('ok')).toContain('bg-success')
    expect(serviceStatusChipClass('degraded')).toContain('bg-warning')
    expect(serviceStatusChipClass('down')).toContain('bg-danger')
    expect(serviceStatusChipClass('unknown')).toContain('bg-passive-4')
    expect(serviceStatusChipClass('weird')).toContain('bg-passive-4')
    expect(serviceStatusChipClass(null)).toContain('bg-passive-4')
  })

  it('labels each status', () => {
    expect(serviceStatusLabel('ok')).toBe('OK')
    expect(serviceStatusLabel('degraded')).toBe('Degraded')
    expect(serviceStatusLabel('down')).toBe('Down')
    expect(serviceStatusLabel('anything')).toBe('Unknown')
  })
})

describe('log helpers', () => {
  it('colours by level, case-insensitively, with sensible fallbacks', () => {
    expect(logLevelColorClass('ERROR')).toBe('text-danger')
    expect(logLevelColorClass('fatal')).toBe('text-danger')
    expect(logLevelColorClass('Warn')).toBe('text-warning')
    expect(logLevelColorClass('warning')).toBe('text-warning')
    expect(logLevelColorClass('debug')).toBe('text-passive-1')
    expect(logLevelColorClass('info')).toBe('text-foreground')
    expect(logLevelColorClass(null)).toBe('text-foreground')
  })

  it('formats a timestamp, passing through unparseable and blank values', () => {
    expect(formatLogTimestamp(null)).toBe('')
    expect(formatLogTimestamp('')).toBe('')
    expect(formatLogTimestamp('not-a-date')).toBe('not-a-date')
    expect(formatLogTimestamp('2026-01-01T00:00:00.000Z')).not.toBe('')
  })

  it('filters over the message case-insensitively', () => {
    const entry: LogEntry = { timestamp: null, service: 'auth', level: 'info', message: 'User Signed In' }
    expect(logMatchesText(entry, '')).toBe(true)
    expect(logMatchesText(entry, '  ')).toBe(true)
    expect(logMatchesText(entry, 'signed')).toBe(true)
    expect(logMatchesText(entry, 'SIGNED')).toBe(true)
    expect(logMatchesText(entry, 'logout')).toBe(false)
  })
})
