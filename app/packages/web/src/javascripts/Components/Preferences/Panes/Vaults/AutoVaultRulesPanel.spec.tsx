/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import AutoVaultRulesPanel from './AutoVaultRulesPanel'
import { useApplication } from '@/Components/ApplicationProvider'
jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: jest.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('shows an actionable conflict and removes only its configured rule without moving notes out of the vault', async () => {
  const setRule = jest.fn().mockResolvedValue(undefined)
  const application = {
    autoVaultRulesService: {
      rules: [{ kind: 'folder', sourceUuid: 'folder', vaultUuid: 'vault' }],
      problems: [{ noteUuid: 'hidden-note-id', reason: 'conflict' }],
      setRule,
      applyRules: jest.fn(),
    },
    items: { findItem: () => ({ title: 'Work' }) },
    vaults: { getVaults: () => [{ uuid: 'vault', name: 'Personal', isSharedVaultListing: () => false }] },
    openPreferences: jest.fn(),
  }
  jest.mocked(useApplication).mockReturnValue(application as never)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(AutoVaultRulesPanel)))
    expect(container.textContent).toContain('Work → Personal')
    expect(container.textContent).toContain('Remove or align the conflicting rules')
    expect(container.textContent).not.toContain('hidden-note-id')
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Review sync')!
        .click(),
    )
    expect(application.openPreferences).toHaveBeenCalledWith('sync')
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Remove rule')!
        .click(),
    )
    expect(setRule).toHaveBeenCalledWith('folder', 'folder')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
