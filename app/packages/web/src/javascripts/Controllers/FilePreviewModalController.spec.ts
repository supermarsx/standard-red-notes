import {
  ContentType,
  FileItem,
  ItemManagerInterface,
  VaultLockServiceEvent,
  VaultLockServiceInterface,
  VaultServiceInterface,
} from '@standardnotes/snjs'
import { FilePreviewModalController } from './FilePreviewModalController'

describe('FilePreviewModalController secure lifecycle', () => {
  let fileStream!: (event: { changed: FileItem[]; removed: { uuid: string }[] }) => void
  let vaultStream!: (event: { removed: { uuid: string }[] }) => void
  let vaultLockObserver!: (event: VaultLockServiceEvent, data: unknown) => void
  let items: jest.Mocked<ItemManagerInterface>
  let vaultLocks: jest.Mocked<VaultLockServiceInterface>
  let vaults: jest.Mocked<VaultServiceInterface>
  let controller: FilePreviewModalController

  const file = (uuid: string, keySystemIdentifier?: string) =>
    ({
      uuid,
      content_type: ContentType.TYPES.File,
      key_system_identifier: keySystemIdentifier,
    }) as FileItem

  beforeEach(() => {
    items = {
      streamItems: jest.fn((types, observer) => {
        if (types === ContentType.TYPES.File) {
          fileStream = observer as typeof fileStream
        } else {
          vaultStream = observer as typeof vaultStream
        }
        return jest.fn()
      }),
    } as unknown as jest.Mocked<ItemManagerInterface>
    vaultLocks = {
      addEventObserver: jest.fn((observer) => {
        vaultLockObserver = observer
        return jest.fn()
      }),
    } as unknown as jest.Mocked<VaultLockServiceInterface>
    vaults = {
      getItemVault: jest.fn(),
    } as unknown as jest.Mocked<VaultServiceInterface>
    controller = new FilePreviewModalController(items, vaultLocks, vaults)
  })

  afterEach(() => controller.deinit())

  it('selects the next surviving file and removes the deleted file from navigation', () => {
    const first = file('first')
    const current = file('current')
    const next = file('next')
    controller.activate(current, [first, current, next])

    fileStream({ changed: [], removed: [{ uuid: current.uuid }] })

    expect(controller.currentFile).toEqual(next)
    expect(controller.otherFiles).toEqual([first, next])
    expect(controller.isOpen).toBe(true)
  })

  it('prunes removed alternatives and never reuses an earlier navigation list', () => {
    const current = file('current')
    const removedAlternative = file('removed-alternative')
    controller.activate(current, [current, removedAlternative])

    fileStream({ changed: [], removed: [{ uuid: removedAlternative.uuid }] })
    expect(controller.currentFile).toEqual(current)
    expect(controller.otherFiles).toEqual([current])

    controller.activate(file('standalone'))
    expect(controller.otherFiles).toEqual([])
  })

  it('scrubs every retained reference on dismiss and matching vault lock', () => {
    const vaultFile = file('vault-file', 'locked-vault-key')
    controller.activate(vaultFile, [vaultFile], { page: 3 })

    vaultLockObserver(VaultLockServiceEvent.VaultLocked, {
      vault: { systemIdentifier: 'locked-vault-key' },
    })

    expect(controller.isOpen).toBe(false)
    expect(controller.currentFile).toBeUndefined()
    expect(controller.otherFiles).toEqual([])
    expect(controller.pdfTarget).toBeUndefined()
  })

  it('closes on listing revocation but ignores unrelated vault lifecycle changes', () => {
    const vaultFile = file('vault-file', 'active-vault-key')
    controller.activate(vaultFile, [vaultFile])
    jest.mocked(vaults.getItemVault).mockReturnValue({ systemIdentifier: 'active-vault-key' } as never)

    vaultLockObserver(VaultLockServiceEvent.VaultLocked, {
      vault: { systemIdentifier: 'unrelated-vault-key' },
    })
    vaultStream({ removed: [{ uuid: 'unrelated-listing' }] })
    expect(controller.currentFile).toEqual(vaultFile)

    jest.mocked(vaults.getItemVault).mockReturnValue(undefined)
    vaultStream({ removed: [{ uuid: 'revoked-listing' }] })
    expect(controller.isOpen).toBe(false)
    expect(controller.currentFile).toBeUndefined()
  })
})
