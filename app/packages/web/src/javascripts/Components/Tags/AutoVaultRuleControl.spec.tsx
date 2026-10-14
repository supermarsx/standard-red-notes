/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import AutoVaultRuleControl from './AutoVaultRuleControl'
import type { SNTag } from '@standardnotes/snjs'
import { useApplication } from '../ApplicationProvider'
jest.mock('../ApplicationProvider', () => ({ useApplication: jest.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('requires a deliberate save and explains shared-vault access and blocked conflicts', async () => {
  const setRule = jest.fn().mockResolvedValue(undefined)
  const application = {
    autoVaultRulesService: { rules: [], previewRule: () => ({ notes: 3, conflicts: 1 }), setRule },
    vaults: { getVaults: () => [{ uuid: 'shared', name: 'Team vault', isSharedVaultListing: () => true }] },
    openPreferences: jest.fn(),
  }
  jest.mocked(useApplication).mockReturnValue(application as never)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(createElement(AutoVaultRuleControl, { source: { uuid: 'topic' } as SNTag, kind: 'tag' })),
    )
    await act(async () => {
      const select = container.querySelector('select')!
      select.value = 'shared'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(setRule).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Members of this shared vault will be able to access assigned notes')
    expect(container.textContent).toContain('3 existing notes')
    expect(container.textContent).toContain('1 match conflicting')
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Save and apply rule')!
        .click(),
    )
    expect(setRule).toHaveBeenCalledWith('tag', 'topic', 'shared')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
