/**
 * @jest-environment jsdom
 *
 * VaultModalMembers — copy guard for the "my own admin membership is Untrusted" symptom (t114).
 *
 * The row only ever knows whether THIS device could resolve a member to a local TrustedContact.
 * That establishes "we hold a trusted record" or "we do not" — it never establishes that the member
 * is untrusted. The row used to render every unresolved member as `<raw uuid> Untrusted`, which for
 * the signed-in user's own admin membership read as an accusation against themselves.
 *
 * tsc cannot see rendered copy, so this drives the real component in jsdom and pins that:
 *   (a) a resolved member is Trusted;
 *   (b) the signed-in user's own unresolved membership says "You" and "Not yet identified",
 *       never a bare uuid;
 *   (c) another unresolved member says "Not in your contacts";
 *   (d) the word "Untrusted" is gone from every state.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { SharedVaultUserServerHash, VaultListingInterface } from '@standardnotes/snjs'

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

jest.mock('@standardnotes/toast', () => ({
  addToast: () => undefined,
  ToastType: { Error: 'error', Success: 'success', Regular: 'regular' },
}))

import { VaultModalMembers } from './VaultModalMembers'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OWN_UUID = '7eb36f92-0121-4a5f-9696-65c19bb4bab0'
const OTHER_UUID = '0f2c1d44-9a81-4bb2-8d1e-2b6d9f0a7c33'
/** A vault owner who is neither the signed-in user nor the member under test. */
const THIRD_PARTY_OWNER_UUID = '4a7b1c93-55de-4f02-9ab8-1c6e7d5f3a21'

const vault = {
  uuid: 'vault-item',
  isSharedVaultListing: () => true,
  sharing: { sharedVaultUuid: 'shared-1', designatedSurvivor: 'someone' },
} as unknown as VaultListingInterface

const member = (userUuid: string, permission = 'admin'): SharedVaultUserServerHash =>
  ({
    uuid: `membership-${userUuid}`,
    user_uuid: userUuid,
    shared_vault_uuid: 'shared-1',
    permission,
    is_designated_survivor: false,
  }) as unknown as SharedVaultUserServerHash

const okResult = { isFailed: () => false, getError: () => '' }

type ApplicationOverrides = {
  /** Whether the SIGNED-IN user owns this vault. Removal is owner-only at every enforcing layer. */
  isCurrentUserSharedVaultOwner?: boolean
  removeUserFromSharedVault?: jest.Mock
  changeMemberPermission?: jest.Mock
  alert?: jest.Mock
  /**
   * Which member the vault OWNER is. Defaults to the signed-in user, as it always did.
   * Overriding it is what lets a test separate "this is my own row" from "this is the
   * owner's row": with the two collapsed onto one uuid, dropping the self gate changed
   * nothing observable and a mutation proved it.
   */
  vaultOwnerUuid?: string
}

const makeApplication = (
  contactsByUserUuid: Record<string, { uuid: string; name: string }>,
  overrides: ApplicationOverrides = {},
) =>
  ({
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
    isNativeMobileWeb: () => false,
    sessions: { getUser: () => ({ uuid: OWN_UUID }) },
    alerts: { alert: overrides.alert ?? jest.fn() },
    contacts: {
      findContactForServerUser: (user: SharedVaultUserServerHash) => contactsByUserUuid[user.user_uuid],
    },
    vaultUsers: {
      isVaultUserOwner: (user: SharedVaultUserServerHash) => user.user_uuid === (overrides.vaultOwnerUuid ?? OWN_UUID),
      isCurrentUserSharedVaultOwner: () => overrides.isCurrentUserSharedVaultOwner ?? true,
      getFormattedMemberPermission: (permission: string) => `Permission: ${permission}`,
      removeUserFromSharedVault: overrides.removeUserFromSharedVault ?? jest.fn().mockResolvedValue(okResult),
      changeMemberPermission: overrides.changeMemberPermission ?? jest.fn().mockResolvedValue(okResult),
    },
  }) as unknown as import('@/Application/WebApplication').WebApplication

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const render = async (
  application: import('@/Application/WebApplication').WebApplication,
  members: SharedVaultUserServerHash[],
  options: { isCurrentUserAdmin?: boolean; onChange?: () => void } = {},
) => {
  await act(async () => {
    root.render(
      createElement(ApplicationProvider, {
        application,
        children: createElement(AndroidBackHandlerProvider, {
          application,
          children: createElement(VaultModalMembers, {
            members,
            vault,
            isCurrentUserAdmin: options.isCurrentUserAdmin ?? true,
            onChange: options.onChange ?? (() => undefined),
          }),
        }),
      }),
    )
  })
}

describe('VaultModalMembers separates unresolvable from untrusted', () => {
  it('(a) labels a member it could resolve as Trusted', async () => {
    const application = makeApplication({ [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } })

    await render(application, [member(OTHER_UUID, 'write')])

    expect(container.textContent).toContain('Chico')
    expect(container.textContent).toContain('Trusted')
    expect(container.textContent).not.toContain('Untrusted')
  })

  it('(b) names the signed-in user and says their record is not yet identified, never a bare uuid', async () => {
    const application = makeApplication({})

    await render(application, [member(OWN_UUID)])

    expect(container.textContent).toContain('You')
    expect(container.textContent).toContain('Not yet identified')
    expect(container.textContent).not.toContain(OWN_UUID)
    expect(container.textContent).not.toContain('Untrusted')
  })

  it('(c) says an unresolved OTHER member is not in your contacts, not that they are untrusted', async () => {
    const application = makeApplication({})

    await render(application, [member(OTHER_UUID, 'read')])

    expect(container.textContent).toContain('Not in your contacts')
    expect(container.textContent).not.toContain('Untrusted')
    // The uuid is all we have for a stranger, so it stays — only the user's OWN uuid is suppressed.
    expect(container.textContent).toContain(OTHER_UUID)
  })

  it('(d) names the signed-in user as You once their own contact resolves', async () => {
    const application = makeApplication({ [OWN_UUID]: { uuid: 'contact-self', name: 'Me' } })

    await render(application, [member(OWN_UUID)])

    expect(container.textContent).toContain('You')
    expect(container.textContent).toContain('Trusted')
    expect(container.textContent).not.toContain('Untrusted')
    expect(container.textContent).not.toContain(OWN_UUID)
  })

  it('(e) still renders every member and their permission', async () => {
    const application = makeApplication({ [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } })

    await render(application, [member(OWN_UUID, 'admin'), member(OTHER_UUID, 'read')])

    expect(container.textContent).toContain('Permission: admin')
    expect(container.textContent).toContain('Permission: read')
    expect(container.textContent).not.toContain('Untrusted')
  })

  it('(f) explains the resolution state in a tooltip rather than only a colour', async () => {
    const application = makeApplication({})

    await render(application, [member(OWN_UUID)])

    const titles = Array.from(container.querySelectorAll('[title]')).map(
      (element) => element.getAttribute('title') ?? '',
    )
    expect(titles.some((title) => title.includes('your own membership'))).toBe(true)
  })
})

/**
 * Removal is OWNER-only wherever it is actually enforced: `VaultUserService.removeUserFromSharedVault`
 * throws unless the signed-in user owns the vault, and the server's `RemoveUserFromSharedVault` fails
 * with "only owner can remove other users from shared vault". The button was gated on
 * `isCurrentUserAdmin`, so an admin MEMBER was offered an action that could only ever fail — and the
 * click handler awaited a throwing call with no catch, so it failed silently.
 */
describe('VaultModalMembers offers removal only to the vault owner', () => {
  const removeButtonLabels = () =>
    Array.from(container.querySelectorAll('button')).map((button) => button.textContent ?? '')

  it('(g) offers removal of another member when the signed-in user owns the vault', async () => {
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { isCurrentUserSharedVaultOwner: true },
    )

    await render(application, [member(OTHER_UUID, 'write')])

    // Precondition: the member on screen is NOT the owner, so the row is eligible for removal at all.
    expect(application.vaultUsers.isVaultUserOwner(member(OTHER_UUID, 'write'))).toBe(false)
    expect(removeButtonLabels().some((label) => label.includes('Remove From Vault'))).toBe(true)
  })

  it('(h) withholds removal from an admin member who does not own the vault', async () => {
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { isCurrentUserSharedVaultOwner: false },
    )

    await render(application, [member(OTHER_UUID, 'admin')])

    // Preconditions: the row rendered at all, and its member is not the vault owner — so the absence
    // below is the owner gate and not an empty list or an owner row.
    expect(container.textContent).toContain('Chico')
    expect(application.vaultUsers.isVaultUserOwner(member(OTHER_UUID, 'admin'))).toBe(false)
    expect(removeButtonLabels().some((label) => label.includes('Remove From Vault'))).toBe(false)
  })

  it('(i) surfaces a thrown removal instead of swallowing it, and still refreshes the list', async () => {
    const removeUserFromSharedVault = jest.fn().mockRejectedValue(new Error('Cannot remove user from locked vault'))
    const alert = jest.fn()
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { isCurrentUserSharedVaultOwner: true, removeUserFromSharedVault, alert },
    )

    const onChange = jest.fn()
    await act(async () => {
      root.render(
        createElement(ApplicationProvider, {
          application,
          children: createElement(AndroidBackHandlerProvider, {
            application,
            children: createElement(VaultModalMembers, {
              members: [member(OTHER_UUID, 'write')],
              vault,
              isCurrentUserAdmin: true,
              onChange,
            }),
          }),
        }),
      )
    })

    const removeButton = Array.from(container.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes('Remove From Vault'),
    )
    // Precondition: there is a button to click, so a passing test cannot mean "nothing happened".
    expect(removeButton).toBeDefined()

    await act(async () => {
      removeButton?.click()
    })

    expect(removeUserFromSharedVault).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith('Cannot remove user from locked vault')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('(j) surfaces a failed removal Result without throwing', async () => {
    const removeUserFromSharedVault = jest
      .fn()
      .mockResolvedValue({ isFailed: () => true, getError: () => 'Only owner can remove other users' })
    const alert = jest.fn()
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { isCurrentUserSharedVaultOwner: true, removeUserFromSharedVault, alert },
    )

    await render(application, [member(OTHER_UUID, 'write')])

    const removeButton = Array.from(container.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes('Remove From Vault'),
    )
    expect(removeButton).toBeDefined()

    await act(async () => {
      removeButton?.click()
    })

    expect(alert).toHaveBeenCalledWith('Only owner can remove other users')
  })
})
/**
 * Standard Red Notes: changing a member's permission IN PLACE.
 *
 * Before this control existed, promoting a member from read to write meant removing them
 * and re-inviting: the vault key rotated and the person lost access until they accepted
 * again. tsc cannot see whether the control is on screen, whether it offers the right
 * options, or whether a change reaches the service, so these drive the real component.
 *
 * The gates mirror the server's, which is the only place authorization is decided:
 * read/write for any admin, `admin` for the OWNER only, never your own row, never the
 * vault owner's row. An affordance that can only ever fail is the bug that moved the
 * remove button off `isCurrentUserAdmin` in the first place.
 */
describe('VaultModalMembers permission control', () => {
  const permissionSelect = (memberUuid: string) =>
    container.querySelector<HTMLSelectElement>(`#vault-member-permission-${memberUuid}`)

  const optionValues = (select: HTMLSelectElement | null) =>
    Array.from(select?.options ?? []).map((option) => option.value)

  const change = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('(k) offers a permission control for another member, pre-set to their current permission', async () => {
    const application = makeApplication({ [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } })

    await render(application, [member(OTHER_UUID, 'read')])

    const select = permissionSelect(OTHER_UUID)
    expect(select).not.toBeNull()
    // Pre-set, not merely present: a control that always reads "read-only" would misreport
    // every write member it is offered for.
    expect(select?.value).toEqual('read')
  })

  it('(l) offers admin only to the vault OWNER, since granting admin is owner-only server-side', async () => {
    const asOwner = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { isCurrentUserSharedVaultOwner: true },
    )
    await render(asOwner, [member(OTHER_UUID, 'read')])
    expect(optionValues(permissionSelect(OTHER_UUID))).toEqual(['read', 'write', 'admin'])

    act(() => {
      root.unmount()
    })
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    const asAdmin = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { isCurrentUserSharedVaultOwner: false },
    )
    await render(asAdmin, [member(OTHER_UUID, 'read')])
    expect(optionValues(permissionSelect(OTHER_UUID))).toEqual(['read', 'write'])
  })

  it('(m) still lists admin when the member ALREADY holds it, so the control cannot misreport them', async () => {
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { isCurrentUserSharedVaultOwner: false },
    )

    await render(application, [member(OTHER_UUID, 'admin')])

    const select = permissionSelect(OTHER_UUID)
    expect(optionValues(select)).toContain('admin')
    expect(select?.value).toEqual('admin')
  })

  /**
   * The self gate and the owner gate are DIFFERENT rules and must be tested apart. With the
   * signed-in user also being the vault owner -- the fake's default, and the first way this
   * test was written -- deleting the self gate changed nothing on screen, because the owner
   * gate already hid the row. A third party owns the vault here, so the signed-in user is a
   * plain admin member and the only thing that can hide their own row is the self gate.
   *
   * It matters because the server refuses a self-change outright ("Cannot change your own
   * permission in a shared vault"): an admin offered the control on their own row would be
   * offered an action that can only fail.
   */
  it('(n) withholds the control from the signed-in user OWN row, even when they are not the vault owner', async () => {
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { vaultOwnerUuid: THIRD_PARTY_OWNER_UUID, isCurrentUserSharedVaultOwner: false },
    )

    await render(application, [member(OWN_UUID, 'admin'), member(OTHER_UUID, 'read')])

    // Preconditions: the control IS offered on this screen, and the signed-in user's row is
    // NOT the owner's row -- so the absence below is the self gate and nothing else.
    expect(permissionSelect(OTHER_UUID)).not.toBeNull()
    expect(application.vaultUsers.isVaultUserOwner(member(OWN_UUID, 'admin'))).toBe(false)
    expect(permissionSelect(OWN_UUID)).toBeNull()
  })

  it('(n2) withholds the control from the VAULT OWNER row, which is a separate rule', async () => {
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { vaultOwnerUuid: THIRD_PARTY_OWNER_UUID, isCurrentUserSharedVaultOwner: false },
    )

    await render(application, [member(THIRD_PARTY_OWNER_UUID, 'admin'), member(OTHER_UUID, 'read')])

    // Preconditions: the control IS offered here, and this row is neither the signed-in user
    // nor an absent one.
    expect(permissionSelect(OTHER_UUID)).not.toBeNull()
    expect(THIRD_PARTY_OWNER_UUID).not.toEqual(OWN_UUID)
    expect(permissionSelect(THIRD_PARTY_OWNER_UUID)).toBeNull()
  })

  it('(o) withholds the control when the signed-in user is not an admin at all', async () => {
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { isCurrentUserSharedVaultOwner: false },
    )

    await render(application, [member(OTHER_UUID, 'read')], { isCurrentUserAdmin: false })

    expect(container.textContent).toContain('Chico')
    expect(permissionSelect(OTHER_UUID)).toBeNull()
  })

  it('(p) sends the chosen permission to the service and refreshes the list', async () => {
    const changeMemberPermission = jest.fn().mockResolvedValue(okResult)
    const onChange = jest.fn()
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { changeMemberPermission },
    )

    await render(application, [member(OTHER_UUID, 'read')], { onChange })

    const select = permissionSelect(OTHER_UUID)
    expect(select).not.toBeNull()

    await change(select as HTMLSelectElement, 'write')

    expect(changeMemberPermission).toHaveBeenCalledTimes(1)
    expect(changeMemberPermission.mock.calls[0][1]).toEqual(OTHER_UUID)
    expect(changeMemberPermission.mock.calls[0][2]).toEqual('write')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('(q) surfaces a refusal from the server instead of a silent dead change', async () => {
    const changeMemberPermission = jest.fn().mockResolvedValue({
      isFailed: () => true,
      getError: () => 'Only the owner can grant admin permission in a shared vault',
    })
    const alert = jest.fn()
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { changeMemberPermission, alert, isCurrentUserSharedVaultOwner: true },
    )

    await render(application, [member(OTHER_UUID, 'read')])

    await change(permissionSelect(OTHER_UUID) as HTMLSelectElement, 'admin')

    expect(alert).toHaveBeenCalledWith('Only the owner can grant admin permission in a shared vault')
  })

  it('(r) surfaces a thrown change rather than leaving the row stuck disabled', async () => {
    const changeMemberPermission = jest.fn().mockRejectedValue(new Error('Cannot change permission in locked vault'))
    const alert = jest.fn()
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { changeMemberPermission, alert },
    )

    await render(application, [member(OTHER_UUID, 'read')])

    await change(permissionSelect(OTHER_UUID) as HTMLSelectElement, 'write')

    expect(alert).toHaveBeenCalledWith('Cannot change permission in locked vault')
    // The control must come back: a row left disabled by a thrown call is unrecoverable
    // without reopening the modal.
    expect(permissionSelect(OTHER_UUID)?.disabled).toBe(false)
  })

  it('(s) does not call the service when the selection did not actually change', async () => {
    const changeMemberPermission = jest.fn().mockResolvedValue(okResult)
    const application = makeApplication(
      { [OTHER_UUID]: { uuid: 'contact-other', name: 'Chico' } },
      { changeMemberPermission },
    )

    await render(application, [member(OTHER_UUID, 'read')])

    await change(permissionSelect(OTHER_UUID) as HTMLSelectElement, 'read')

    expect(changeMemberPermission).not.toHaveBeenCalled()
  })
})
