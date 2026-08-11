/**
 * @jest-environment jsdom
 */
import { useApplication } from '@/Components/ApplicationProvider'
import { DecryptedItemInterface } from '@standardnotes/snjs'
import { act, createElement, useLayoutEffect } from 'react'
import { Root, createRoot } from 'react-dom/client'
import { useItemVaultInfo } from './useItemVaultInfo'

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: jest.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mockUseApplication = useApplication as jest.Mock

type HookResult = ReturnType<typeof useItemVaultInfo>
let result: HookResult

const captureResult = (value: HookResult) => {
  result = value
}

const Harness = ({
  item,
  onResult,
}: {
  item: DecryptedItemInterface | undefined
  onResult: (value: HookResult) => void
}) => {
  const value = useItemVaultInfo(item)
  useLayoutEffect(() => onResult(value), [onResult, value])
  return null
}

describe('useItemVaultInfo', () => {
  let container: HTMLElement
  let root: Root
  let application: {
    featuresController: { isVaultsEnabled: jest.Mock }
    vaultDisplayService: { getItemVault: jest.Mock }
    sharedVaults: { getItemLastEditedBy: jest.Mock; getItemSharedBy: jest.Mock }
    items: { streamItems: jest.Mock }
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    application = {
      featuresController: { isVaultsEnabled: jest.fn().mockReturnValue(true) },
      vaultDisplayService: { getItemVault: jest.fn() },
      sharedVaults: {
        getItemLastEditedBy: jest.fn(),
        getItemSharedBy: jest.fn(),
      },
      items: { streamItems: jest.fn().mockReturnValue(jest.fn()) },
    }
    mockUseApplication.mockReturnValue(application)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('clears state and skips item calls and subscriptions when the selection is empty', () => {
    const item = { uuid: 'note-1' } as DecryptedItemInterface
    const vault = { uuid: 'vault-1' }
    const lastEditedBy = { uuid: 'contact-1' }
    const sharedBy = { uuid: 'contact-2' }
    application.vaultDisplayService.getItemVault.mockReturnValue(vault)
    application.sharedVaults.getItemLastEditedBy.mockReturnValue(lastEditedBy)
    application.sharedVaults.getItemSharedBy.mockReturnValue(sharedBy)

    act(() => root.render(createElement(Harness, { item, onResult: captureResult })))
    expect(result).toEqual({ vault, lastEditedByContact: lastEditedBy, sharedByContact: sharedBy })
    expect(application.items.streamItems).toHaveBeenCalledTimes(2)

    act(() => root.render(createElement(Harness, { item: undefined, onResult: captureResult })))
    expect(result).toEqual({ vault: undefined, lastEditedByContact: undefined, sharedByContact: undefined })
    expect(application.vaultDisplayService.getItemVault).toHaveBeenCalledTimes(1)
    expect(application.sharedVaults.getItemLastEditedBy).toHaveBeenCalledTimes(1)
    expect(application.sharedVaults.getItemSharedBy).toHaveBeenCalledTimes(1)
    expect(application.items.streamItems).toHaveBeenCalledTimes(2)
  })

  it('does not dereference or subscribe for an initially empty selection', () => {
    act(() => root.render(createElement(Harness, { item: undefined, onResult: captureResult })))

    expect(result).toEqual({ vault: undefined, lastEditedByContact: undefined, sharedByContact: undefined })
    expect(application.vaultDisplayService.getItemVault).not.toHaveBeenCalled()
    expect(application.sharedVaults.getItemLastEditedBy).not.toHaveBeenCalled()
    expect(application.sharedVaults.getItemSharedBy).not.toHaveBeenCalled()
    expect(application.items.streamItems).not.toHaveBeenCalled()
  })

  it('clears prior contact attribution when the next selected item has none', () => {
    const first = { uuid: 'note-1' } as DecryptedItemInterface
    const second = { uuid: 'note-2' } as DecryptedItemInterface
    const priorContact = { uuid: 'contact-1' }
    application.sharedVaults.getItemLastEditedBy.mockImplementation((item: DecryptedItemInterface) => {
      return item.uuid === first.uuid ? priorContact : undefined
    })

    act(() => root.render(createElement(Harness, { item: first, onResult: captureResult })))
    expect(result.lastEditedByContact).toBe(priorContact)

    act(() => root.render(createElement(Harness, { item: second, onResult: captureResult })))
    expect(result.lastEditedByContact).toBeUndefined()
  })
})
