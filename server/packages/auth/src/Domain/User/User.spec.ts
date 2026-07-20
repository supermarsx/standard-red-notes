import { User } from './User'

describe('User', () => {
  const createUser = () => new User()

  it('should indicate if support sessions', () => {
    const user = createUser()
    user.version = '004'

    expect(user.supportsSessions()).toBeTruthy()
  })

  it('should indicate if does not support sessions', () => {
    const user = createUser()
    user.version = '003'

    expect(user.supportsSessions()).toBeFalsy()
  })

  it('should indicate if the user is potentially a vault account', () => {
    const user = createUser()
    user.email = 'a75a31ce95365904ef0e0a8e6cefc1f5e99adfef81bbdb6d4499eeb10ae0ff67'

    expect(user.isPotentiallyAPrivateUsernameAccount()).toBeTruthy()
  })

  it('should indicate if the user is not a vault account', () => {
    const user = createUser()
    user.email = 'test@test.te'

    expect(user.isPotentiallyAPrivateUsernameAccount()).toBeFalsy()
  })

  // Standard Red Notes: email_confirmed is a tinyint(1). isEmailConfirmed() must
  // treat the NUMBER 1 and the boolean true as confirmed, and a NULL/undefined
  // value (legacy row / unset entity) as confirmed so the gate never locks out.
  it('isEmailConfirmed treats 1 / true as confirmed and 0 / false as unconfirmed', () => {
    const user = createUser()

    user.emailConfirmed = 1 as unknown as boolean
    expect(user.isEmailConfirmed()).toBe(true)
    user.emailConfirmed = true
    expect(user.isEmailConfirmed()).toBe(true)
    user.emailConfirmed = 0 as unknown as boolean
    expect(user.isEmailConfirmed()).toBe(false)
    user.emailConfirmed = false
    expect(user.isEmailConfirmed()).toBe(false)
  })

  it('isEmailConfirmed treats an unset value as confirmed (never lock out)', () => {
    const user = createUser()
    expect(user.isEmailConfirmed()).toBe(true)
    user.emailConfirmed = null as unknown as boolean
    expect(user.isEmailConfirmed()).toBe(true)
  })

  // Standard Red Notes: the banned column is a tinyint(1) — TypeORM hydrates it
  // from MySQL/MariaDB as the NUMBER 0/1, while SetUserBanStatus assigns a real
  // boolean before saving. isBanned() must treat BOTH representations as banned;
  // the old strict `=== true` check reported every persisted ban as "not banned"
  // and bans were silently never enforced (SignIn + AuthenticateUser).
  it('should report banned for the in-memory boolean representation', () => {
    const user = createUser()
    user.banned = true

    expect(user.isBanned()).toBe(true)
  })

  it('should report banned for the tinyint-hydrated numeric representation', () => {
    const user = createUser()
    user.banned = 1 as unknown as boolean

    expect(user.isBanned()).toBe(true)
  })

  it('should report not banned for falsy representations', () => {
    const user = createUser()

    user.banned = false
    expect(user.isBanned()).toBe(false)

    user.banned = 0 as unknown as boolean
    expect(user.isBanned()).toBe(false)
  })

  // Standard Red Notes: richer ban semantics.
  it('treats a legacy banned row with no ban_type as a permanent, access-blocking ban', () => {
    const user = createUser()
    user.banned = true
    user.banType = null

    expect(user.effectiveBanType()).toBe('permanent')
    expect(user.isBanned()).toBe(true)
    expect(user.isAccessBlocked()).toBe(true)
    expect(user.isShadowBanned()).toBe(false)
  })

  it('permanent ban is access-blocking', () => {
    const user = createUser()
    user.banned = true
    user.banType = 'permanent'
    user.banReason = 'abuse'

    expect(user.isAccessBlocked()).toBe(true)
    expect(user.banReason).toBe('abuse')
  })

  it('temporary ban blocks access only until it expires', () => {
    const user = createUser()
    user.banned = true
    user.banType = 'temporary'

    const future = new Date('2026-07-10T00:00:00.000Z')
    const past = new Date('2026-06-01T00:00:00.000Z')
    user.bannedUntil = future

    // Before the deadline: banned + access-blocked.
    const beforeDeadline = new Date('2026-07-01T00:00:00.000Z')
    expect(user.isBanned(beforeDeadline)).toBe(true)
    expect(user.isAccessBlocked(beforeDeadline)).toBe(true)

    // After the deadline: treated as NOT banned.
    const afterDeadline = new Date('2026-07-20T00:00:00.000Z')
    expect(user.isBanned(afterDeadline)).toBe(false)
    expect(user.isAccessBlocked(afterDeadline)).toBe(false)

    // A past deadline is already expired.
    user.bannedUntil = past
    expect(user.isBanned(beforeDeadline)).toBe(false)
  })

  it('shadow ban is active but NOT access-blocking', () => {
    const user = createUser()
    user.banned = true
    user.banType = 'shadow'

    expect(user.isBanned()).toBe(true)
    expect(user.isShadowBanned()).toBe(true)
    expect(user.isAccessBlocked()).toBe(false)
    expect(user.effectiveBanType()).toBe('shadow')
  })

  // Standard Red Notes: reversible admin SUSPENSION. Like the ban columns,
  // `suspended` is a tinyint(1): isSuspended() must treat BOTH the number 1 and
  // the boolean true as suspended, and an unset value as not suspended.
  it('isSuspended treats 1 / true as suspended and 0 / false / unset as not', () => {
    const user = createUser()

    expect(user.isSuspended()).toBe(false)
    user.suspended = 1 as unknown as boolean
    expect(user.isSuspended()).toBe(true)
    user.suspended = true
    expect(user.isSuspended()).toBe(true)
    user.suspended = 0 as unknown as boolean
    expect(user.isSuspended()).toBe(false)
    user.suspended = false
    expect(user.isSuspended()).toBe(false)
  })

  it('a suspended user is access-blocked (folded into isAccessBlocked) even with no ban', () => {
    const user = createUser()
    user.banned = false
    user.suspended = true

    expect(user.isBanned()).toBe(false)
    expect(user.isSuspended()).toBe(true)
    expect(user.isAccessBlocked()).toBe(true)
  })

  it('a not-suspended, not-banned user is not access-blocked', () => {
    const user = createUser()

    expect(user.isSuspended()).toBe(false)
    expect(user.isAccessBlocked()).toBe(false)
  })

  // banned is a tinyint(1): TypeORM hydrates it as the NUMBER 0/1 while
  // SetUserBanStatus assigns a real boolean. effectiveBanType must read both.
  it('effectiveBanType returns null for every unbanned representation', () => {
    for (const banned of [0, false, null, undefined]) {
      const user = createUser()
      user.banned = banned as unknown as boolean
      user.banType = 'permanent'

      expect(user.effectiveBanType()).toBeNull()
    }
  })

  it('effectiveBanType reads the numeric 1 as banned and defaults a typeless ban to permanent', () => {
    const numeric = createUser()
    numeric.banned = 1 as unknown as boolean
    numeric.banType = 'shadow'
    expect(numeric.effectiveBanType()).toEqual('shadow')

    const legacy = createUser()
    legacy.banned = true
    legacy.banType = null
    expect(legacy.effectiveBanType()).toEqual('permanent')
  })
})
