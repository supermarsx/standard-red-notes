/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { confirmDialog } from '@standardnotes/ui-services'
import AdminUserMfa from './AdminUserMfa'
jest.mock('@standardnotes/ui-services', () => ({ confirmDialog: jest.fn().mockResolvedValue(true) }))
jest.mock('@standardnotes/snjs', () => ({ isErrorResponse: (value: { error?: unknown }) => Boolean(value.error) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  jest.mocked(confirmDialog).mockResolvedValue(true)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  jest.clearAllMocks()
})
const clear = {
  totpConfigured: false,
  securityKeyCount: 0,
  magicLinkEnabled: false,
  recoveryCodesAvailable: false,
  trustedDeviceCount: 0,
  appPasswordCount: 0,
  openSessionCount: 0,
}
const configured = {
  ...clear,
  totpConfigured: true,
  securityKeyCount: 2,
  recoveryCodesAvailable: true,
  trustedDeviceCount: 1,
  appPasswordCount: 3,
  openSessionCount: 4,
  secret: 'must-never-display',
}
const render = async (api: unknown, uuid = 'user-a', onReset = jest.fn()) => {
  await act(async () => {
    root.render(
      createElement(AdminUserMfa, {
        application: { legacyApi: api } as never,
        userUuid: uuid,
        email: uuid + '@test.invalid',
        noteIfForbidden: () => undefined,
        onReset,
      }),
    )
    await Promise.resolve()
  })
}
const reset = async () => {
  await act(async () => {
    ;[...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Reset all sign-in factors')!
      .click()
    await Promise.resolve()
  })
}
it('shows safe factor status and confirms every removed factor and forced signout before reset', async () => {
  const api = {
      adminGetUserMfaStatus: jest.fn().mockResolvedValue({ data: configured }),
      adminResetAllUserFactors: jest
        .fn()
        .mockResolvedValue({ data: { success: true, userUuid: 'user-a', scope: 'all_factors', status: clear } }),
    },
    onReset = jest.fn()
  await render(api, 'user-a', onReset)
  expect(container.textContent).toContain('Configured')
  expect(container.textContent).not.toContain('must-never-display')
  await reset()
  const dialog = jest.mocked(confirmDialog).mock.calls[0][0]
  expect(dialog.text).toContain('security keys')
  expect(dialog.text).toContain('app passwords')
  expect(dialog.text).toContain('signs out every open session')
  expect(api.adminResetAllUserFactors).toHaveBeenCalledWith('user-a')
  expect(onReset).toHaveBeenCalledWith('user-a')
  expect(container.textContent).toContain('Not configured')
})
it('does not send a reset if confirmation is canceled', async () => {
  jest.mocked(confirmDialog).mockResolvedValueOnce(false)
  const api = {
    adminGetUserMfaStatus: jest.fn().mockResolvedValue({ data: configured }),
    adminResetAllUserFactors: jest.fn(),
  }
  await render(api)
  await reset()
  expect(api.adminResetAllUserFactors).not.toHaveBeenCalled()
})
it('withdraws a pending confirmation if another target is selected', async () => {
  let finish!: (value: boolean) => void
  jest.mocked(confirmDialog).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const api = {
    adminGetUserMfaStatus: jest.fn().mockResolvedValue({ data: configured }),
    adminResetAllUserFactors: jest.fn(),
  }
  await render(api)
  await reset()
  await render(api, 'user-b')
  await act(async () => {
    finish(true)
    await Promise.resolve()
  })
  expect(api.adminResetAllUserFactors).not.toHaveBeenCalled()
})
it('never reports a partial or wrong-target reset as complete', async () => {
  const api = {
      adminGetUserMfaStatus: jest.fn().mockResolvedValue({ data: configured }),
      adminResetAllUserFactors: jest
        .fn()
        .mockResolvedValue({ data: { success: true, userUuid: 'other', scope: 'all_factors', status: clear } }),
    },
    onReset = jest.fn()
  await render(api, 'user-a', onReset)
  await reset()
  expect(onReset).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
})

it('does not send a late confirmed reset after the target component unmounts', async () => {
  let finish!: (confirmed: boolean) => void
  jest.mocked(confirmDialog).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const api = {
    adminGetUserMfaStatus: jest.fn().mockResolvedValue({ data: configured }),
    adminResetAllUserFactors: jest.fn(),
  }
  await render(api)
  await reset()
  await act(async () => root.render(null))
  await act(async () => {
    finish(true)
    await Promise.resolve()
  })
  expect(api.adminResetAllUserFactors).not.toHaveBeenCalled()
})
