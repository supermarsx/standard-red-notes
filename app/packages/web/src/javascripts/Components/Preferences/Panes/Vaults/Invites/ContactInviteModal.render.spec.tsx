/**
 * @jest-environment jsdom
 *
 * ContactInviteModal — RENDER guard for the silent-invite-failure fix (t101).
 *
 * Nearly every way `inviteContactToSharedVault` fails aborts inside the use case
 * BEFORE any request is issued (no account keypair, no key system root key, no
 * `isMe` contact for the vault, an unencryptable recipient key) and is reported
 * only as a `Result` failure. The modal used to discard that Result and close
 * unconditionally, so a send that never left the client looked identical to a
 * successful one. tsc and the SendContactInvites unit spec do NOT prove the real
 * modal wires the outcome to the alert, so this drives <ContactInviteModal> in
 * jsdom and pins:
 *   (a) loaded contacts render with a visible "Invite Selected Contacts" action;
 *   (b) a failing invite alerts with the reason and keeps the modal OPEN;
 *   (c) a succeeding invite closes the modal and raises no alert.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { Result, SharedVaultListingInterface, TrustedContactInterface } from '@standardnotes/snjs'

// Modal's responsive layout reads matchMedia, which jsdom does not implement.
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

import ContactInviteModal from './ContactInviteModal'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const vault = {
  name: 'Team vault',
  systemIdentifier: 'vault-1',
  sharing: { sharedVaultUuid: 'shared-1' },
} as unknown as SharedVaultListingInterface

const alice = { uuid: 'a', name: 'Alice', contactUuid: 'user-a' } as unknown as TrustedContactInterface

const makeApplication = (inviteResult: Result<unknown> | Promise<Result<unknown>>) => {
  const alert = jest.fn().mockResolvedValue(undefined)
  const inviteContactToSharedVault = jest.fn().mockResolvedValue(inviteResult)

  const application = {
    alerts: { alert },
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
    isNativeMobileWeb: () => false,
    vaultUsers: { getFormattedMemberPermission: (permission: string) => permission },
    vaultInvites: {
      getInvitableContactsForSharedVault: async () => [alice],
      inviteContactToSharedVault,
    },
  } as unknown as import('@/Application/WebApplication').WebApplication

  return { application, alert, inviteContactToSharedVault }
}

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

const buttons = () => Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]

const findButton = (label: string) => buttons().find((button) => (button.textContent ?? '').includes(label))

const click = async (element: Element | undefined) => {
  expect(element).toBeDefined()
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const render = async (
  application: import('@/Application/WebApplication').WebApplication,
  onCloseDialog: () => void,
) => {
  await act(async () => {
    root.render(
      createElement(ApplicationProvider, {
        application,
        children: createElement(AndroidBackHandlerProvider, {
          application,
          children: createElement(ContactInviteModal, { vault, onCloseDialog }),
        }),
      }),
    )
  })
  // The contact list is loaded by an async effect.
  await act(async () => {
    await Promise.resolve()
  })
}

describe('ContactInviteModal surfaces invites that never leave the client', () => {
  it('(a) renders the loaded contact and a visible invite action', async () => {
    const { application } = makeApplication(Result.ok({}))

    await render(application, jest.fn())

    expect(container.textContent).toContain('Alice')
    expect(container.textContent).not.toContain('No contacts available to invite.')
    expect(findButton('Invite Selected Contacts')).toBeDefined()
  })

  it('(b) alerts the reason and keeps the modal open when the invite fails before any request', async () => {
    const onCloseDialog = jest.fn()
    const { application, alert, inviteContactToSharedVault } = makeApplication(
      Result.fail('Cannot invite contact; me contact not found'),
    )

    await render(application, onCloseDialog)

    await click(container.querySelector('input[type="checkbox"]') ?? undefined)
    await click(findButton('Invite Selected Contacts'))

    expect(inviteContactToSharedVault).toHaveBeenCalledWith(vault, alice, 'read')
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0][0]).toContain('Alice: Cannot invite contact; me contact not found')
    expect(onCloseDialog).not.toHaveBeenCalled()
    // Still open and still actionable, not stuck behind the in-flight spinner.
    expect(findButton('Invite Selected Contacts')?.disabled).toBe(false)
  })

  it('(c) closes without alerting when the invite succeeds', async () => {
    const onCloseDialog = jest.fn()
    const { application, alert } = makeApplication(Result.ok({}))

    await render(application, onCloseDialog)

    await click(container.querySelector('input[type="checkbox"]') ?? undefined)
    await click(findButton('Invite Selected Contacts'))

    expect(alert).not.toHaveBeenCalled()
    expect(onCloseDialog).toHaveBeenCalledTimes(1)
  })
})
