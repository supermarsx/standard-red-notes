/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ApplicationEvent } from '@standardnotes/snjs'
import AdminLogsTab from './AdminLogsTab'

jest.mock('@standardnotes/snjs', () => ({
  isErrorResponse: (value: { error?: unknown }) => Boolean(value.error),
  ApplicationEvent: { SignedIn: 'signed-in', SignedOut: 'signed-out' },
}))
jest.mock('@/Components/Dropdown/Dropdown', () => ({
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
    disabled: boolean
  }) =>
    createElement(
      'select',
      {
        'aria-label': label,
        value,
        disabled,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      },
      items.map((item) => createElement('option', { key: item.value, value: item.value }, item.label)),
    ),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let unmounted: boolean
beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-10-14T12:00:00.000Z'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  unmounted = false
})
afterEach(async () => {
  if (!unmounted) {
    await act(async () => root.unmount())
  }
  container.remove()
  jest.useRealTimers()
})

const setup = (fetch: jest.Mock) => {
  let userUuid: string | undefined = 'admin-a'
  let observe!: (event: ApplicationEvent) => void
  const dispose = jest.fn()
  const forbidden = jest.fn()
  const application = {
    sessions: { getUser: () => (userUuid ? { uuid: userUuid } : undefined) },
    legacyApi: { adminGetLogs: fetch },
    addEventObserver: (callback: typeof observe) => {
      observe = callback
      return dispose
    },
  }
  return {
    application,
    forbidden,
    dispose,
    event: (event: ApplicationEvent, uuid?: string) => {
      userUuid = uuid
      observe(event)
    },
  }
}
const render = async (fixture: ReturnType<typeof setup>) => {
  await act(async () =>
    root.render(
      createElement(AdminLogsTab, { application: fixture.application as never, noteIfForbidden: fixture.forbidden }),
    ),
  )
}
const select = async (label: string, value: string) => {
  const element = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
  await act(async () => {
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const click = async (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === label)
  expect(button).toBeDefined()
  await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
const logs = (message = 'current line') => ({
  data: { entries: [{ timestamp: '2026-10-14T11:00:00Z', service: 'auth', level: 'info', message }] },
})

it('defaults to newest-first, displays full UTC timestamps, and sends a rolling time-window query', async () => {
  const fetch = jest.fn().mockResolvedValue({
    data: {
      entries: [
        { timestamp: '2026-10-14T11:00:00Z', service: 'auth', level: 'info', message: 'older line' },
        { timestamp: '2026-10-14T11:59:00Z', service: 'auth', level: 'warn', message: 'newest line' },
        { timestamp: null, service: null, level: null, message: 'legacy line' },
      ],
    },
  })
  await render(setup(fetch))
  expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ order: 'desc', since: undefined }))
  expect(container.textContent).toContain('2026-10-14 11:59:00.000 UTC')
  expect(container.textContent).toContain('Timestamp unavailable')
  expect(container.textContent!.indexOf('newest line')).toBeLessThan(container.textContent!.indexOf('older line'))
  const levels = Array.from(container.querySelectorAll('select[aria-label="Log level filter"] option')).map(
    (entry) => (entry as HTMLOptionElement).value,
  )
  expect(levels).toEqual(['', 'error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly', 'trace', 'fatal'])
  await select('Log level filter', 'verbose')
  expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'verbose' }))
  await select('Log chronological order', 'asc')
  await select('Log time window', '15')
  expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ order: 'asc', since: '2026-10-14T11:45:00.000Z' }))
  expect(container.textContent!.indexOf('older line')).toBeLessThan(container.textContent!.indexOf('newest line'))
})

it('does not overlap auto-refresh, queues the latest changed query, and discards the stale response', async () => {
  let finish!: (value: unknown) => void
  const fetch = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(logs())
  const fixture = setup(fetch)
  await render(fixture)
  await act(async () => jest.advanceTimersByTime(45_000))
  expect(fetch).toHaveBeenCalledTimes(1)
  await select('Log chronological order', 'asc')
  await select('Log time window', '15')
  expect(fetch).toHaveBeenCalledTimes(1)
  await act(async () => finish({ status: 403, error: { message: 'old request' } }))
  expect(fixture.forbidden).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ order: 'asc', since: '2026-10-14T11:45:45.000Z' }))
  expect(container.textContent).toContain('current line')
  await click('Pause auto-refresh')
  await act(async () => jest.advanceTimersByTime(30_000))
  expect(fetch).toHaveBeenCalledTimes(2)
  await click('Start auto-refresh')
  await act(async () => jest.advanceTimersByTime(15_000))
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('ignores an old response across same-account sign-out/sign-in and removes refresh work on unmount', async () => {
  let finish!: (value: unknown) => void
  const fetch = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(logs('replacement session line'))
  const fixture = setup(fetch)
  await render(fixture)
  await act(async () => {
    fixture.event(ApplicationEvent.SignedOut)
    fixture.event(ApplicationEvent.SignedIn, 'admin-a')
    finish(logs('old session line'))
  })
  expect(container.textContent).not.toContain('old session line')
  await act(async () => jest.advanceTimersByTime(15_000))
  expect(container.textContent).toContain('replacement session line')
  await act(async () => root.unmount())
  unmounted = true
  await act(async () => jest.advanceTimersByTime(60_000))
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fixture.dispose).toHaveBeenCalledTimes(1)
})

it('drops a late forbidden response after unmount without notifying the parent', async () => {
  let finish!: (value: unknown) => void
  const fetch = jest.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const fixture = setup(fetch)
  await render(fixture)
  await act(async () => root.unmount())
  unmounted = true
  await act(async () => finish({ status: 403, error: { message: 'private backend detail' } }))
  expect(fixture.forbidden).not.toHaveBeenCalled()
  expect(container.textContent).toBe('')
})

it('debounces literal server-side message search and bounds it to 256 characters', async () => {
  const fetch = jest.fn().mockResolvedValue(logs())
  await render(setup(fetch))
  const input = container.querySelector('input[placeholder="Search retained messages…"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '[literal]')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => jest.advanceTimersByTime(349))
  expect(fetch).toHaveBeenCalledTimes(1)
  await act(async () => jest.advanceTimersByTime(1))
  expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ search: '[literal]' }))
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'x'.repeat(400))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    jest.advanceTimersByTime(350)
  })
  await act(async () => jest.advanceTimersByTime(350))
  expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'x'.repeat(256) }))
})

it('clears previous application entries before fetching replacement-account logs', async () => {
  const first = setup(jest.fn().mockResolvedValue(logs('previous account detail')))
  await render(first)
  expect(container.textContent).toContain('previous account detail')
  let finish!: (value: unknown) => void
  const next = setup(
    jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    ),
  )
  await render(next)
  expect(container.textContent).not.toContain('previous account detail')
  await act(async () => finish(logs('replacement account detail')))
  expect(container.textContent).toContain('replacement account detail')
  expect(first.dispose).toHaveBeenCalledTimes(1)
})
