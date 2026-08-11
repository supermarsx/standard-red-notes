/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success' },
}))

jest.mock('@standardnotes/snjs', () => ({
  isErrorResponse: (response: unknown) => Boolean((response as { error?: unknown })?.error),
  classNames: (...values: unknown[]) => values.filter(Boolean).join(' '),
}))

jest.mock('@/Components/Dropdown/Dropdown', () => {
  const { createElement: h } = jest.requireActual('react')
  return {
    __esModule: true,
    default: ({
      label,
      items,
      value,
      onChange,
      disabled,
    }: {
      label: string
      items: { label: string; value: string }[]
      value: string
      onChange: (value: string) => void
      disabled?: boolean
    }) =>
      h(
        'select',
        {
          'aria-label': label,
          value,
          disabled,
          onChange: (event: { target: { value: string } }) => onChange(event.target.value),
        },
        items.map((item) => h('option', { key: item.value, value: item.value }, item.label)),
      ),
  }
})

import AdminEmailDeliveryTab from './AdminEmailDeliveryTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings = {
  emailDelivery: {
    host: 'smtp.example.com',
    port: 587,
    username: 'mailer',
    passwordConfigured: true,
    from: 'Standard Red Notes <notes@example.com>',
    tlsMode: 'starttls' as const,
    configured: true,
  },
}

let root: Root
let container: HTMLDivElement
let saveSettings: jest.Mock
let adminTestEmailDelivery: jest.Mock

const render = async () => {
  saveSettings = jest.fn().mockResolvedValue(true)
  adminTestEmailDelivery = jest.fn().mockResolvedValue({ data: { ok: true } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(AdminEmailDeliveryTab, {
        application: { legacyApi: { adminTestEmailDelivery } } as never,
        settings,
        sources: {
          'emailDelivery.host': 'env',
          'emailDelivery.password': 'persisted',
        },
        loading: false,
        unavailable: false,
        error: null,
        saving: false,
        noteIfForbidden: jest.fn(),
        onRetry: jest.fn(),
        saveSettings,
      } as never),
    )
  })
}

const setInput = async (id: string, value: string): Promise<void> => {
  const input = container.querySelector<HTMLInputElement>(`#${id}`) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const click = async (label: string): Promise<void> => {
  const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === label)
  expect(button).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(async () => {
  await render()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows configured write-only status and preserves the password on ordinary partial saves', async () => {
  const passwordInput = container.querySelector<HTMLInputElement>('#email-smtp-password')
  expect(passwordInput?.value).toBe('')
  expect(passwordInput?.placeholder).toBe('Leave blank to preserve')
  expect(container.textContent).toContain('Password: configured (write-only)')

  await setInput('email-smtp-host', 'smtp2.example.com')
  await click('Save email delivery')

  const patch = saveSettings.mock.calls[0][0]
  expect(patch.emailDelivery.host).toBe('smtp2.example.com')
  expect(patch.emailDelivery).not.toHaveProperty('password')
})

it('sends password null only after an explicit clear action', async () => {
  await click('Clear saved password')
  expect(container.textContent).toContain('environment password may become active')
  await click('Save email delivery')

  expect(saveSettings).toHaveBeenCalledWith(
    expect.objectContaining({ emailDelivery: expect.objectContaining({ password: null }) }),
    'Email delivery settings saved.',
  )
})

it('shows the insecure-transport warning and never displays a raw provider error', async () => {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="SMTP TLS mode"]') as HTMLSelectElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  setter?.call(select, 'insecure')
  await act(async () => {
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(container.textContent).toContain('Insecure transport exposes email and credentials')

  adminTestEmailDelivery.mockResolvedValue({
    error: true,
    status: 502,
    data: { message: '550 secret provider response' },
  })
  await setInput('email-smtp-host', '127.0.0.1')
  const recipientInput = container.querySelector<HTMLInputElement>('input[placeholder="operator@example.com"]')
  expect(recipientInput).not.toBeNull()
  const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  inputSetter?.call(recipientInput, 'operator@example.com')
  await act(async () => {
    recipientInput?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Send test')

  expect(adminTestEmailDelivery).toHaveBeenCalledWith('operator@example.com')
  expect(container.textContent).toContain('The test failed. Check the SMTP settings and the server logs.')
  expect(container.textContent).not.toContain('550 secret provider response')
})
