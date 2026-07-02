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
})
