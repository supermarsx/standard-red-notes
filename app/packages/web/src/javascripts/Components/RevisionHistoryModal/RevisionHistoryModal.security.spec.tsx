/**
 * @jest-environment jsdom
 */
import { WebApplication } from '@/Application/WebApplication'
import { ContentType, SNNote, VaultLockServiceEvent } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import RevisionHistoryModal from './RevisionHistoryModal'

jest.mock('./HistoryModalDialogContent', () => ({
  __esModule: true,
  default: () => 'decrypted-revision-content',
}))
jest.mock('./HistoryModalDialog', () => ({
  __esModule: true,
  default: 'div',
}))
jest.mock('@/NativeMobileWeb/useAndroidBackHandler', () => ({
  useAndroidBackHandler: () => jest.fn(() => jest.fn()),
}))
jest.mock('../Modal/useModalAnimation', () => ({
  // Keep the shell mounted to model the exit animation. Sensitive content must
  // still disappear synchronously when authorization becomes false.
  useModalAnimation: () => [true, jest.fn()],
}))
jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm' },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('RevisionHistoryModal vault authorization', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('removes revision plaintext immediately on vault lock even while the modal shell remains mounted', () => {
    let authorized = true
    let vaultLockObserver!: (event: VaultLockServiceEvent) => void
    const note = {
      uuid: 'vault-note',
      content_type: ContentType.TYPES.Note,
      key_system_identifier: 'vault-key-system',
    } as SNNote
    const historyModalController = {
      note: note as SNNote | undefined,
      dismissModal: jest.fn(),
    }
    historyModalController.dismissModal.mockImplementation(() => {
      historyModalController.note = undefined
    })
    const application = {
      historyModalController,
      isAuthorizedToRenderItem: jest.fn(() => authorized),
      addEventObserver: jest.fn(() => jest.fn()),
      vaultLocks: {
        addEventObserver: jest.fn((observer) => {
          vaultLockObserver = observer
          return jest.fn()
        }),
      },
      items: {
        streamItems: jest.fn(() => jest.fn()),
      },
    } as unknown as WebApplication

    act(() => root.render(createElement(RevisionHistoryModal, { application })))
    expect(container.textContent).toContain('decrypted-revision-content')

    authorized = false
    act(() => vaultLockObserver(VaultLockServiceEvent.VaultLocked))

    expect(container.firstElementChild).not.toBeNull()
    expect(container.textContent).not.toContain('decrypted-revision-content')
    expect(historyModalController.dismissModal).toHaveBeenCalledTimes(1)

    authorized = true
    act(() => vaultLockObserver(VaultLockServiceEvent.VaultUnlocked))
    expect(container.textContent).not.toContain('decrypted-revision-content')
  })
})
