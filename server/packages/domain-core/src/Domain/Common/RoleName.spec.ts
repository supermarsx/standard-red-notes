import { RoleName } from './RoleName'

describe('RoleName', () => {
  it('should create a value object', () => {
    const valueOrError = RoleName.create(RoleName.NAMES.ProUser)

    expect(valueOrError.isFailed()).toBeFalsy()
    expect(valueOrError.getValue().value).toEqual('PRO_USER')
  })

  it('should not create an invalid value object', () => {
    for (const value of ['', undefined, null, 0, 'SOME_USER']) {
      const valueOrError = RoleName.create(value as string)

      expect(valueOrError.isFailed()).toBeTruthy()
    }
  })

  it('should say if a role has more power or equal power to another role', () => {
    const proUserRole = RoleName.create(RoleName.NAMES.ProUser).getValue()
    const plusUserRole = RoleName.create(RoleName.NAMES.PlusUser).getValue()
    const coreUser = RoleName.create(RoleName.NAMES.CoreUser).getValue()
    const internalTeamUser = RoleName.create(RoleName.NAMES.InternalTeamUser).getValue()

    expect(internalTeamUser.hasMoreOrEqualPowerTo(proUserRole)).toBeTruthy()
    expect(internalTeamUser.hasMoreOrEqualPowerTo(proUserRole)).toBeTruthy()
    expect(internalTeamUser.hasMoreOrEqualPowerTo(plusUserRole)).toBeTruthy()
    expect(internalTeamUser.hasMoreOrEqualPowerTo(coreUser)).toBeTruthy()

    expect(proUserRole.hasMoreOrEqualPowerTo(internalTeamUser)).toBeFalsy()
    expect(proUserRole.hasMoreOrEqualPowerTo(proUserRole)).toBeTruthy()
    expect(proUserRole.hasMoreOrEqualPowerTo(plusUserRole)).toBeTruthy()
    expect(proUserRole.hasMoreOrEqualPowerTo(coreUser)).toBeTruthy()

    expect(plusUserRole.hasMoreOrEqualPowerTo(internalTeamUser)).toBeFalsy()
    expect(plusUserRole.hasMoreOrEqualPowerTo(proUserRole)).toBeFalsy()
    expect(plusUserRole.hasMoreOrEqualPowerTo(plusUserRole)).toBeTruthy()
    expect(plusUserRole.hasMoreOrEqualPowerTo(coreUser)).toBeTruthy()

    expect(coreUser.hasMoreOrEqualPowerTo(internalTeamUser)).toBeFalsy()
    expect(coreUser.hasMoreOrEqualPowerTo(proUserRole)).toBeFalsy()
    expect(coreUser.hasMoreOrEqualPowerTo(plusUserRole)).toBeFalsy()
    expect(coreUser.hasMoreOrEqualPowerTo(coreUser)).toBeTruthy()
  })

  it('should be reflexive for VaultsUser (has power >= itself)', () => {
    const vaultsUser = RoleName.create(RoleName.NAMES.VaultsUser).getValue()
    const coreUser = RoleName.create(RoleName.NAMES.CoreUser).getValue()
    const plusUserRole = RoleName.create(RoleName.NAMES.PlusUser).getValue()
    const proUserRole = RoleName.create(RoleName.NAMES.ProUser).getValue()
    const internalTeamUser = RoleName.create(RoleName.NAMES.InternalTeamUser).getValue()

    // Reflexivity: a VaultsUser must have power >= a VaultsUser.
    expect(vaultsUser.hasMoreOrEqualPowerTo(vaultsUser)).toBeTruthy()

    // Existing sibling relation to CoreUser is preserved.
    expect(vaultsUser.hasMoreOrEqualPowerTo(coreUser)).toBeTruthy()

    // VaultsUser does not outrank the paid/internal roles.
    expect(vaultsUser.hasMoreOrEqualPowerTo(plusUserRole)).toBeFalsy()
    expect(vaultsUser.hasMoreOrEqualPowerTo(proUserRole)).toBeFalsy()
    expect(vaultsUser.hasMoreOrEqualPowerTo(internalTeamUser)).toBeFalsy()

    // CoreUser remains a sibling: it does not gain power over VaultsUser.
    expect(coreUser.hasMoreOrEqualPowerTo(vaultsUser)).toBeFalsy()
    // Higher roles still outrank VaultsUser via their CoreUser-inclusive arms
    // (Pro/Plus include CoreUser but not VaultsUser); InternalTeamUser outranks all.
    expect(internalTeamUser.hasMoreOrEqualPowerTo(vaultsUser)).toBeTruthy()
  })
})
