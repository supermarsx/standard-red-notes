/**
 * @jest-environment jsdom
 */
import { WebApplication } from '@/Application/WebApplication'
import { ContentType, FileItem, VaultLockServiceEvent } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { useItemAuthorization } from './useItemAuthorization'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const Harness = ({ application, file }: { application: WebApplication; file: FileItem }) => {
  const authorized = useItemAuthorization(application, file)
  return createElement('div', null, authorized ? 'decrypted-content' : 'blocked')
}

describe('useItemAuthorization vault lifecycle', () => {
  let container: HTMLElement
  let root: Root
  let authorized: boolean
  let vaultLockObserver!: (event: VaultLockServiceEvent) => void
  let vaultListingObserver!: (event: { changed: unknown[]; inserted: unknown[]; removed: { uuid: string }[] }) => void
  let itemObserver!: (event: {
    changed: { uuid: string }[]
    inserted: { uuid: string }[]
    removed: { uuid: string }[]
  }) => void
  let application: WebApplication
  let file: FileItem

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    authorized = true
    file = {
      uuid: 'vault-file',
      content_type: ContentType.TYPES.File,
      key_system_identifier: 'vault-key-system',
    } as FileItem

    application = {
      isAuthorizedToRenderItem: jest.fn(() => authorized),
      addEventObserver: jest.fn(() => jest.fn()),
      vaultLocks: {
        addEventObserver: jest.fn((observer) => {
          vaultLockObserver = observer
          return jest.fn()
        }),
      },
      items: {
        streamItems: jest.fn((types, observer) => {
          if (types === ContentType.TYPES.VaultListing) {
            vaultListingObserver = observer
          } else {
            itemObserver = observer
          }
          return jest.fn()
        }),
      },
    } as unknown as WebApplication
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('fails closed reactively on vault lock and listing removal', () => {
    act(() => root.render(createElement(Harness, { application, file })))
    expect(container.textContent).toBe('decrypted-content')

    authorized = false
    act(() => vaultLockObserver(VaultLockServiceEvent.VaultLocked))
    expect(container.textContent).toBe('blocked')

    authorized = true
    act(() => vaultLockObserver(VaultLockServiceEvent.VaultUnlocked))
    expect(container.textContent).toBe('decrypted-content')

    authorized = false
    act(() =>
      vaultListingObserver({
        changed: [],
        inserted: [],
        removed: [{ uuid: 'revoked-vault-listing' }],
      }),
    )
    expect(container.textContent).toBe('blocked')
  })

  it('denies a directly removed item even while its stale vault identifier still resolves', () => {
    act(() => root.render(createElement(Harness, { application, file })))
    expect(container.textContent).toBe('decrypted-content')

    authorized = false
    act(() =>
      itemObserver({
        changed: [],
        inserted: [],
        removed: [{ uuid: file.uuid }],
      }),
    )

    expect(application.isAuthorizedToRenderItem).toHaveBeenCalled()
    expect(container.textContent).toBe('blocked')

    act(() => vaultLockObserver(VaultLockServiceEvent.VaultUnlocked))
    expect(container.textContent).toBe('blocked')

    authorized = true
    act(() =>
      itemObserver({
        changed: [],
        inserted: [{ uuid: file.uuid }],
        removed: [],
      }),
    )
    expect(container.textContent).toBe('decrypted-content')
  })

  it('does not carry an authorized value across an item identity change', () => {
    act(() => root.render(createElement(Harness, { application, file })))
    expect(container.textContent).toBe('decrypted-content')

    const nextFile = { ...file, uuid: 'newly-selected-file' } as FileItem
    authorized = false
    act(() => root.render(createElement(Harness, { application, file: nextFile })))

    expect(container.textContent).toBe('blocked')
  })

  it('rechecks authorization after subscribing when a lock lands in the render-to-subscribe gap', () => {
    jest.mocked(application.addEventObserver).mockImplementation(() => {
      authorized = false
      return jest.fn()
    })

    act(() => root.render(createElement(Harness, { application, file })))

    expect(container.textContent).toBe('blocked')
  })
})
