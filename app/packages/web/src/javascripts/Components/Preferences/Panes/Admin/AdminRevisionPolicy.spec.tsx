import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import type { WebApplication } from '@/Application/WebApplication'
import AdminRevisionPolicy, { AdminUserRevisionPolicy } from './AdminRevisionPolicy'

jest.mock('@standardnotes/toast', () => ({ addToast: jest.fn(), ToastType: { Success: 'success' } }))
jest.mock('@standardnotes/snjs', () => ({
  isErrorResponse: (value: { error?: unknown }) => Boolean(value.error),
  classNames: (...values: unknown[]) => values.filter(Boolean).join(' '),
}))
jest.mock('@/Components/Button/Button', () => ({
  __esModule: true,
  default: ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) =>
    createElement('button', { onClick, disabled }, label),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const userA = '00000000-0000-4000-8000-000000000001',
  userB = '00000000-0000-4000-8000-000000000002'
const policy = {
  retentionDays: 900,
  maxCountPerItem: 200,
  maxCountPerUser: 0,
  maxBytesPerUser: 0,
  maxCountTotal: 0,
  maxBytesTotal: 0,
  debounceSeconds: 30,
  checkpointSeconds: 300,
  users: { [userA]: { maxCount: 50 }, [userB]: { maxCount: 80 } },
}
const response = () => ({ status: 200, data: { settings: { revisions: policy } } })
describe('revision policy management', () => {
  let container: HTMLDivElement, root: Root
  let get: jest.Mock, set: jest.Mock, application: WebApplication
  const forbidden = jest.fn()
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    get = jest.fn().mockResolvedValue(response())
    set = jest.fn().mockResolvedValue(response())
    application = {
      legacyApi: { adminGetServerSettings: get, adminSetServerSettings: set },
    } as unknown as WebApplication
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const render = async (userUuid?: string) =>
    act(async () =>
      root.render(createElement(AdminRevisionPolicy, { application, userUuid, noteIfForbidden: forbidden })),
    )
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === label)!
  it('shows the default retention and saves all supported server-wide limits', async () => {
    await render()
    expect([...container.querySelectorAll('input')].map((input) => input.value)).toEqual([
      '200',
      '900',
      '0',
      '0',
      '0',
      '0',
      '30',
      '300',
    ])
    await act(async () => button('Save revision limits').click())
    expect(set).toHaveBeenCalledWith({
      revisions: {
        retentionDays: 900,
        maxCountPerItem: 200,
        maxCountPerUser: 0,
        maxBytesPerUser: 0,
        maxCountTotal: 0,
        maxBytesTotal: 0,
        debounceSeconds: 30,
        checkpointSeconds: 300,
      },
    })
  })
  it('writes only the selected user override and can restore inheritance', async () => {
    await render(userA)
    await act(async () => button('Save revision limits').click())
    expect(set).toHaveBeenCalledWith({
      revisions: { users: { [userA]: { maxCount: 50, maxBytes: null, maxCountPerItem: null, retentionDays: null } } },
    })
    await act(async () => button('Use server limits').click())
    expect(set).toHaveBeenLastCalledWith({ revisions: { users: { [userA]: null } } })
  })
  it('keeps the user subsection compact and loads it only when opened', async () => {
    await act(async () =>
      root.render(createElement(AdminUserRevisionPolicy, { application, userUuid: userA, noteIfForbidden: forbidden })),
    )
    expect(get).not.toHaveBeenCalled()
    expect(container.querySelectorAll('input')).toHaveLength(0)
    await act(async () => {
      const details = container.querySelector('details')!
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    expect(get).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll('input')).toHaveLength(4)
  })
  it('discards an earlier user read when the administrator switches accounts', async () => {
    let finishA!: (value: ReturnType<typeof response>) => void
    get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishA = resolve
        }),
    )
    await render(userA)
    await render(userB)
    await act(async () => finishA(response()))
    expect(container.querySelectorAll('input')[2].value).toBe('80')
    await act(async () => button('Save revision limits').click())
    expect(set).toHaveBeenLastCalledWith({
      revisions: { users: { [userB]: expect.objectContaining({ maxCount: 80 }) } },
    })
  })
  it('keeps saving disabled if the server did not supply this capability', async () => {
    get.mockResolvedValue({ status: 200, data: { settings: {} } })
    await render()
    expect(button('Save revision limits').disabled).toBe(true)
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Update the server')
  })
})
