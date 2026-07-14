/**
 * PreferencesSessionController — self-serve Invite pane menu registration (t69
 * §7.5). The pane must appear in the Preferences menu ONLY when the server
 * enables referral invites (registration.invitesPerUser > 0). The controller
 * probes listMyInviteLinks() once on construction and adds the entry when the
 * response says the feature is enabled. Memory guard: a menu entry gated by a
 * special case has silently vanished before, so pin both directions here.
 */
import { PreferencesSessionController } from './PreferencesSessionController'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const okList = (data: unknown) => ({ status: 200, data })

const makeApplication = (listResponse: unknown) => {
  const listMyInviteLinks = jest.fn().mockResolvedValue(listResponse)
  return {
    application: {
      featuresController: {
        isVaultsEnabled: () => false,
        isAdminUser: () => false,
      },
      getPreference: () => false,
      status: {
        addEventObserver: () => () => undefined,
        getPreferencesBubbleCount: () => 0,
      },
      items: { invalidNonVaultedItems: [] },
      addEventObserver: () => () => undefined,
      legacyApi: { listMyInviteLinks },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    listMyInviteLinks,
  }
}

const hasInvite = (controller: PreferencesSessionController) =>
  controller.menuItems.some((item) => item.id === 'invite')

describe('PreferencesSessionController — self-serve Invite pane gating', () => {
  it('adds the "Invite friends" entry when invitesPerUser > 0', async () => {
    const { application, listMyInviteLinks } = makeApplication(okList({ invitesPerUser: 3, inviteLinks: [] }))
    const controller = new PreferencesSessionController(application, false)

    // Not present synchronously (before the async probe resolves)...
    expect(hasInvite(controller)).toBe(false)

    await flush()

    expect(listMyInviteLinks).toHaveBeenCalledTimes(1)
    expect(hasInvite(controller)).toBe(true)
    const item = controller.menuItems.find((i) => i.id === 'invite')
    expect(item?.label).toBe('Invite friends')
  })

  it('does NOT add the entry when invitesPerUser is 0 (self-serve disabled)', async () => {
    const { application } = makeApplication(okList({ invitesPerUser: 0, inviteLinks: [] }))
    const controller = new PreferencesSessionController(application, false)

    await flush()

    expect(hasInvite(controller)).toBe(false)
  })

  it('does NOT add the entry when the probe errors (non-2xx)', async () => {
    const { application } = makeApplication({ status: 403, data: { error: { message: 'nope' } } })
    const controller = new PreferencesSessionController(application, false)

    await flush()

    expect(hasInvite(controller)).toBe(false)
  })

  it('does not add the entry twice on repeated resolution', async () => {
    const { application } = makeApplication(okList({ invitesPerUser: 2, inviteLinks: [] }))
    const controller = new PreferencesSessionController(application, false)

    await flush()
    await flush()

    expect(controller.menuItems.filter((i) => i.id === 'invite')).toHaveLength(1)
  })
})
