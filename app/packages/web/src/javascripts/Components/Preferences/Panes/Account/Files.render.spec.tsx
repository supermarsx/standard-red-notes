/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: the Account pane's FILE storage quota had one state for
 * three different answers.
 *
 *   - A read that THREW (network failure, 401, 500) was swallowed by a
 *     `.catch(console.error)` placed where `setIsLoading(false)` could no longer
 *     run, so the pane kept its spinner for the lifetime of the tab. That is the
 *     "stuck on loading perpetually" report, seen from the preferences side.
 *   - A read that answered NOTHING (`getSubscriptionSetting` maps the server's
 *     400 for an account with no subscription record to `undefined`) left the
 *     component's `0` initial state in place and rendered `0 B` — a fabricated
 *     measurement. That is the "account size reporting is 0 b all the time"
 *     report.
 *   - A real zero also rendered `0 B`, so the two were indistinguishable.
 *
 * These tests pin all three apart. The pair that matters most is "unreported"
 * versus "a genuine zero": if the fix merely relabelled every zero, the last
 * test here fails.
 *
 * The repo has no @testing-library, so React is driven directly through
 * react-dom/client's createRoot + act (mirroring ReloadApp.render.spec).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

import FilesSection from './Files'
import type { WebApplication } from '@/Application/WebApplication'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const getSubscriptionSetting = jest.fn()
const isSignedIntoFirstPartyServer = jest.fn()

const applicationStub = () =>
  ({
    settings: { getSubscriptionSetting },
    sessions: { isSignedIntoFirstPartyServer },
  }) as unknown as WebApplication

let container: HTMLElement
let root: Root
let consoleError: jest.SpyInstance

beforeEach(() => {
  getSubscriptionSetting.mockReset()
  isSignedIntoFirstPartyServer.mockReset().mockReturnValue(false)
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  consoleError.mockRestore()
})

const render = async () => {
  await act(async () => {
    root.render(createElement(FilesSection, { application: applicationStub() }))
  })
  await act(async () => {})
}

const text = () => container.textContent ?? ''
const spinner = () => container.querySelector('.animate-spin')
const findButton = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((button) => (button.textContent ?? '').includes(label))

const clickButton = async (label: string) => {
  const button = findButton(label)
  expect(button).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

describe('Account pane file storage quota', () => {
  it('renders a figure the server did report, with a usage bar against the limit', async () => {
    isSignedIntoFirstPartyServer.mockReturnValue(true)
    getSubscriptionSetting.mockResolvedValueOnce('1048576').mockResolvedValueOnce('10485760')

    await render()

    // Precondition: both settings were actually asked for.
    expect(getSubscriptionSetting).toHaveBeenCalledTimes(2)
    expect(spinner()).toBeNull()
    expect(text()).toContain('1 MB')
    expect(text()).toContain('10 MB')
    const bar = container.querySelector('progress')
    expect(bar?.getAttribute('max')).toBe('10485760')
    expect(bar?.getAttribute('value')).toBe('1048576')
  })

  it('surfaces a FAILED read as a stated failure with a retry, never as a spinner', async () => {
    getSubscriptionSetting.mockRejectedValue(new Error('Network request failed'))

    await render()

    // The defect being pinned: this used to still be a spinner, forever.
    expect(spinner()).toBeNull()
    expect(text()).toContain('Could not read your file storage usage.')
    expect(text()).toContain('Network request failed')
    expect(findButton('Try again')).toBeDefined()
    // A failure must not be dressed up as a measurement of any size.
    expect(text()).not.toContain('used')
    expect(container.querySelector('progress')).toBeNull()
    expect(consoleError).toHaveBeenCalled()
  })

  it('retrying after a failure reads again and replaces the failure with the figure', async () => {
    getSubscriptionSetting.mockRejectedValueOnce(new Error('Network request failed'))

    await render()
    expect(text()).toContain('Could not read your file storage usage.')
    expect(getSubscriptionSetting).toHaveBeenCalledTimes(1)

    getSubscriptionSetting.mockResolvedValue('2048')
    await clickButton('Try again')

    expect(getSubscriptionSetting).toHaveBeenCalledTimes(2)
    expect(text()).not.toContain('Could not read your file storage usage.')
    expect(text()).toContain('2 KB')
  })

  it('says the server reported NO figure instead of inventing a zero', async () => {
    // `SettingsGateway.getSubscriptionSetting` answers `undefined` for the
    // server's 400 (no subscription record for this account) and for a setting
    // that simply is not there.
    getSubscriptionSetting.mockResolvedValue(undefined)

    await render()

    expect(getSubscriptionSetting).toHaveBeenCalledTimes(1)
    expect(spinner()).toBeNull()
    expect(text()).toContain('Not reported by the server')
    expect(text()).toContain('not a measured zero')
    // The exact fabrication this replaces.
    expect(text()).not.toContain('0 B')
    expect(container.querySelector('progress')).toBeNull()
  })

  it('still reports a GENUINE zero as zero, so the two answers stay distinct', async () => {
    getSubscriptionSetting.mockResolvedValue('0')

    await render()

    expect(text()).toContain('0 B')
    expect(text()).toContain('used')
    expect(text()).not.toContain('Not reported by the server')
  })

  it('does not claim an unlimited allowance when a first-party limit is absent', async () => {
    isSignedIntoFirstPartyServer.mockReturnValue(true)
    getSubscriptionSetting.mockResolvedValueOnce('1024').mockResolvedValueOnce(undefined)

    await render()

    expect(text()).toContain('1 KB')
    expect(text()).toContain('an allowance the server did not report')
    expect(text()).not.toContain('∞')
    expect(container.querySelector('progress')).toBeNull()
  })
})
