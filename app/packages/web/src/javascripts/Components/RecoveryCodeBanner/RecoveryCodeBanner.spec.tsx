/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import type { WebApplication } from '@/Application/WebApplication'
import RecoveryCodeBanner from './RecoveryCodeBanner'
jest.mock('../StyledTooltip/StyledTooltip', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('MFA recovery code reveal', () => {
  let container: HTMLElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  const render = async (promptForAccountPassword: jest.Mock, execute: jest.Mock) => {
    await act(async () =>
      root.render(
        createElement(RecoveryCodeBanner, {
          application: {
            challenges: { promptForAccountPassword },
            getRecoveryCodes: { execute },
          } as unknown as WebApplication,
        }),
      ),
    )
  }
  it('does not reveal or generate a code when password verification is cancelled', async () => {
    const execute = jest.fn()
    await render(jest.fn().mockResolvedValue(null), execute)
    await act(async () => container.querySelector('button')!.click())
    expect(execute).not.toHaveBeenCalled()
    expect(container.querySelector('button')!.disabled).toBe(false)
  })
  it('handles a rejected request, clears loading and permits a successful retry without keeping an old error', async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ isFailed: () => false, getValue: () => 'local-fixture-recovery' })
    await render(jest.fn().mockResolvedValue('local-password'), execute)
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Try again')
    expect(container.querySelector('button')!.disabled).toBe(false)
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[role=alert]')).toBeNull()
    expect(container.textContent).toContain('local-fixture-recovery')
  })
})
