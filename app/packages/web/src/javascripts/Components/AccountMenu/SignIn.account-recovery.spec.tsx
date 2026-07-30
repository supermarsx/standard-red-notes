/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@standardnotes/snjs', () => ({
  getCaptchaHeader: () => '',
  getErrorFromErrorResponse: () => ({ message: 'error' }),
  isErrorResponse: () => false,
}))
jest.mock('@/Hooks/useCaptcha', () => ({
  useCaptcha: () => null,
}))
jest.mock('@/Achievements', () => ({
  achievements: { increment: jest.fn() },
  METRICS: { failedLoginsTotal: 'failed-logins' },
}))
jest.mock('./AdvancedOptions', () => () => null)

let mockApplication: ReturnType<typeof createApplication>
jest.mock('../ApplicationProvider', () => ({
  useApplication: () => mockApplication,
}))

import SignIn from './SignIn'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const successfulResult = (value: unknown) => ({
  isFailed: () => false,
  getValue: () => value,
})

const createApplication = (result: unknown) => ({
  accountMenuController: {
    notesAndTagsCount: 0,
    closeAccountMenu: jest.fn(),
  },
  recoverAccount: {
    execute: jest.fn().mockResolvedValue(result),
  },
  signInWithRecoveryCodes: { execute: jest.fn() },
  signIn: jest.fn(),
})

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const renderRecovery = async () => {
  await act(async () => {
    root.render(createElement(SignIn, { setMenuPane: jest.fn() }))
  })
  const entry = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Recover account with an account recovery code'),
  )
  await act(async () => {
    entry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const setInputValue = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const fillAndSubmit = async () => {
  const code = container.querySelector<HTMLInputElement>('input[placeholder="Account recovery code"]')!
  const password = container.querySelector<HTMLInputElement>('input[placeholder="Strong new password"]')!
  const confirmation = container.querySelector<HTMLInputElement>('input[placeholder="Confirm new password"]')!
  await setInputValue(code, 'SRN-RECOVERY-V2.code')
  await setInputValue(password, 'strong new password')
  await setInputValue(confirmation, 'strong new password')
  const submit = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Recover account and change password'),
  )
  await act(async () => {
    submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return { code, password, confirmation }
}

it('clears recovery secrets and removes Back to sign in after a partial signed-in outcome', async () => {
  mockApplication = createApplication(
    successfulResult({
      signedIn: true,
      passwordReset: false,
      passwordResetError: 'Retry from Security preferences.',
    }),
  )
  await renderRecovery()

  const inputs = await fillAndSubmit()

  expect(inputs.code.value).toBe('')
  expect(inputs.password.value).toBe('')
  expect(inputs.confirmation.value).toBe('')
  expect(container.textContent).toContain('You are signed in, but the password was not changed.')
  expect(container.textContent).not.toContain('Back to sign in')
  expect(container.textContent).toContain('Close')
})

it('renders a bounded manual-copy fallback when clipboard access fails', async () => {
  mockApplication = createApplication(
    successfulResult({
      signedIn: true,
      passwordReset: true,
      recoveryCode: 'fresh-one-time-code',
    }),
  )
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: jest.fn().mockRejectedValue(new Error('sensitive platform detail')) },
  })
  await renderRecovery()
  await fillAndSubmit()

  const copy = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Copy recovery code'),
  )
  await act(async () => {
    copy?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  expect(container.textContent).toContain('The recovery code could not be copied. Select it and save it manually.')
  expect(container.textContent).not.toContain('sensitive platform detail')
})
