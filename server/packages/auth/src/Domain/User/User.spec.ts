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
})
