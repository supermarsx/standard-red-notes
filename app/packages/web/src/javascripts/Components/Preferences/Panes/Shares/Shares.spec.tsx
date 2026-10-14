/** @jest-environment jsdom */
import { act, createElement, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

const mockWrapper = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
jest.mock('@/Components/Preferences/PreferencesComponents/Content', () => ({
  Subtitle: mockWrapper,
  Text: mockWrapper,
  Title: mockWrapper,
}))
jest.mock('@/Components/Preferences/PreferencesComponents/PreferencesGroup', () => ({
  __esModule: true,
  default: mockWrapper,
}))
jest.mock('@/Components/Preferences/PreferencesComponents/PreferencesPane', () => ({
  __esModule: true,
  default: mockWrapper,
}))
jest.mock('@/Components/Preferences/PreferencesComponents/PreferencesSegment', () => ({
  __esModule: true,
  default: mockWrapper,
}))

import Shares from './Shares'
import { shareExpiresAt } from './shareExpiry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('changes Active to Expired at the calculated boundary without requiring a cleanup flag or another HTTP request', async () => {
  const share = {
    uuid: 'share',
    type: 'note',
    nickname: 'Shared note',
    createdAt: '2026-10-09T10:41:33Z',
    revoked: false,
    viewExpiresMinutes: 15,
    firstOpenedAt: '2026-10-09T10:41:37Z',
  }
  const expiry = shareExpiresAt(share)!
  jest.useFakeTimers().setSystemTime(expiry - 1)
  const listShares = jest.fn().mockResolvedValue({ data: { shares: [share] } })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(Shares, { application: { legacyApi: { listShares } } as never })))
    expect(container.textContent).toContain('note · Active')
    expect(container.textContent).toContain(`Expires ${new Date(expiry).toLocaleString()}`)
    await act(async () => jest.advanceTimersByTimeAsync(1))
    expect(container.textContent).toContain('note · Expired')
    expect(container.querySelector('button')).toBeNull()
    expect(listShares).toHaveBeenCalledTimes(1)
  } finally {
    act(() => root.unmount())
    container.remove()
    jest.useRealTimers()
  }
})
