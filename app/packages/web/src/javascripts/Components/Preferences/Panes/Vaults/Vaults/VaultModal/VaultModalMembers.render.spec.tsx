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

const makeApplication = (contactsByUserUuid: Record<string, { uuid: string; name: string }>) =>
  ({
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
    isNativeMobileWeb: () => false,
    sessions: { getUser: () => ({ uuid: OWN_UUID }) },
    contacts: {
      findContactForServerUser: (user: SharedVaultUserServerHash) => contactsByUserUuid[user.user_uuid],
    },
    vaultUsers: {
      isVaultUserOwner: (user: SharedVaultUserServerHash) => user.user_uuid === OWN_UUID,
      getFormattedMemberPermission: (permission: string) => `Permission: ${permission}`,
      removeUserFromSharedVault: jest.fn(),
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
            isCurrentUserAdmin: true,
            onChange: () => undefined,
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
