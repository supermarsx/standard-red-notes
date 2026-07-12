/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: INVITE-URL signup control + APPROVAL queue — ConfirmPassword
 * render/behavior guard (MEMORY: verify UI render paths; tsc/jest green is not
 * proof a pane behaves). These drive the REAL ConfirmPassword pane in jsdom and
 * assert:
 *   - register is called WITH the invite token when the launch carried `?invite=`,
 *   - register is called WITHOUT one (trailing arg undefined) when it did not,
 *   - a pendingApproval:true register response shows the awaiting-approval screen
 *     and does NOT proceed to a signed-in state (no closeAccountMenu / pane swap).
 *
 * The repo has no @testing-library, so we drive React directly with
 * react-dom/client's createRoot + act (mirroring AdminUsersTab.spec).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

// Translate keys to themselves so assertions can match on the key text.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// Treat a response as an error only when it carries an explicit error field.
jest.mock('@standardnotes/snjs', () => ({
  isErrorResponse: (response: unknown) => Boolean((response as { error?: unknown })?.error),
}))

// Only RouteType is consumed from ui-services by this pane.
jest.mock('@standardnotes/ui-services', () => ({
  RouteType: { Invite: 'invite', None: 'none' },
}))

// useApplication() reads from React context via ApplicationProvider; inject our
// mock application instead of standing up the whole provider tree.
let mockApplication: ReturnType<typeof makeApplication>
jest.mock('../ApplicationProvider', () => ({
  useApplication: () => mockApplication,
}))

import ConfirmPassword from './ConfirmPassword'
import { AccountMenuPane } from './AccountMenuPane'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const EMAIL = 'invitee@example.com'
const PASSWORD = 'a-strong-password'

type RouteResult = { type: string; inviteParams?: { token: string } }

const makeApplication = (route: RouteResult, registerResult: unknown = { session: { access_token: 't' } }) => ({
  accountMenuController: {
    notesAndTagsCount: 0,
    closeAccountMenu: jest.fn(),
    setCurrentPane: jest.fn(),
  },
  getCaptchaUrl: jest.fn().mockResolvedValue({ data: { captchaUIUrl: '' } }),
  register: jest.fn().mockResolvedValue(registerResult),
  routeService: {
    getRoute: jest.fn().mockReturnValue(route),
  },
})

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

const render = async () => {
  await act(async () => {
    root.render(
      createElement(ConfirmPassword, {
        setMenuPane: jest.fn(),
        email: EMAIL,
        password: PASSWORD,
      }),
    )
  })
}

const setInputValue = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// Type the matching confirm password and submit, then flush the getCaptchaUrl +
// register promise chain.
const submitRegistration = async () => {
  const confirmInput = Array.from(container.querySelectorAll('input')).find(
    (i) => i.type !== 'checkbox',
  ) as HTMLInputElement
  await setInputValue(confirmInput, PASSWORD)

  const submit = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('createAccountAndSignIn'),
  ) as HTMLButtonElement

  await act(async () => {
    submit.click()
  })
  // Flush getCaptchaUrl().then(...) → register().then(...) → setState.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ConfirmPassword — invite token threading + pending-approval handling', () => {
  it('threads the invite token into register when the launch carried ?invite=', async () => {
    mockApplication = makeApplication({ type: 'invite', inviteParams: { token: 'raw-invite-token' } })

    await render()
    await submitRegistration()

    expect(mockApplication.register).toHaveBeenCalledTimes(1)
    // register(email, password, hvmToken, ephemeral, mergeLocal, workspaceIdentifier, inviteToken)
    const call = mockApplication.register.mock.calls[0]
    expect(call[0]).toEqual(EMAIL)
    expect(call[6]).toEqual('raw-invite-token')
  })

  it('does NOT pass an invite token when the launch carried no ?invite=', async () => {
    mockApplication = makeApplication({ type: 'none' })

    await render()
    await submitRegistration()

    expect(mockApplication.register).toHaveBeenCalledTimes(1)
    expect(mockApplication.register.mock.calls[0][6]).toBeUndefined()
  })

  it('shows the awaiting-approval screen on a pendingApproval response, not a signed-in state', async () => {
    mockApplication = makeApplication({ type: 'invite', inviteParams: { token: 'tok' } }, { pendingApproval: true })

    await render()
    await submitRegistration()

    expect(mockApplication.register).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('awaitingApprovalTitle')
    expect(container.textContent).toContain('awaitingApprovalMessage')
    // Must NOT proceed to a signed-in state.
    expect(mockApplication.accountMenuController.closeAccountMenu).not.toHaveBeenCalled()
    expect(mockApplication.accountMenuController.setCurrentPane).not.toHaveBeenCalledWith(AccountMenuPane.GeneralMenu)
  })

  it('proceeds to a signed-in state on a normal (non-pending) registration', async () => {
    mockApplication = makeApplication({ type: 'none' })

    await render()
    await submitRegistration()

    expect(mockApplication.accountMenuController.closeAccountMenu).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('awaitingApprovalTitle')
  })
})
