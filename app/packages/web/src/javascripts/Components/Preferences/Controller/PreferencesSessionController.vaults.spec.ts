import { PreferencesSessionController } from './PreferencesSessionController'

const createApplication = (isVaultsEnabled: boolean) => {
  return {
    featuresController: {
      isVaultsEnabled: () => isVaultsEnabled,
      isAdminUser: () => false,
    },
    getPreference: () => false,
    status: {
      addEventObserver: () => () => undefined,
      getPreferencesBubbleCount: () => 0,
    },
    items: { invalidNonVaultedItems: [] },
    addEventObserver: () => () => undefined,
    legacyApi: {
      listMyInviteLinks: jest.fn().mockResolvedValue({ status: 404 }),
    },
  } as never
}

describe('PreferencesSessionController Vaults menu gating', () => {
  it('shows Vaults when the current user has the capability', () => {
    const controller = new PreferencesSessionController(createApplication(true), false)

    expect(controller.menuItems).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'vaults' })]))
  })

  it('keeps Vaults hidden when the current user has no capability', () => {
    const controller = new PreferencesSessionController(createApplication(false), false)

    expect(controller.menuItems).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'vaults' })]))
  })
})
