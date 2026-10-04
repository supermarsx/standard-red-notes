import { ContentType } from '@standardnotes/domain-core'
import { TrustedContactInterface } from '@standardnotes/models'
import { SelfContactManager } from './SelfContactManager'
import { InternalFeature } from '../InternalFeatures/InternalFeature'
import { InternalFeatureService } from '../InternalFeatures/InternalFeatureService'
import { SyncEvent } from '../Event/SyncEvent'

/**
 * The self-contact used to be created only behind `InternalFeature.Vaults`, a flag that ONLY
 * `DevMode` sets — so a shipped build (webpack `mode: 'production'` ⇒ `isDev === false`) never
 * created one, while still offering the whole vaults UI to admins and SharedVaults-entitled
 * accounts. Every invite then failed with "me contact not found" and the owner's own membership
 * rendered as a bare uuid labelled "Untrusted".
 *
 * These tests deliberately NEVER enable that internal feature, so they fail if the gate returns.
 */
describe('SelfContactManager', () => {
  let sync: { addEventObserver: jest.Mock }
  let items: { addObserver: jest.Mock }
  let session: {
    isSignedIn: jest.Mock
    isUserMissingKeyPair: jest.Mock
    getSureUser: jest.Mock
    getPublicKey: jest.Mock
    getSigningPublicKey: jest.Mock
  }
  let singletons: { findSingleton: jest.Mock; findOrCreateSingleton: jest.Mock }
  let syncObserver: (event: SyncEvent) => void

  const created = { uuid: 'item-1', contactUuid: 'user-1', isMe: true } as unknown as TrustedContactInterface

  const createManager = () =>
    new SelfContactManager(sync as never, items as never, session as never, singletons as never)

  beforeEach(() => {
    syncObserver = () => undefined
    sync = {
      addEventObserver: jest.fn((observer: (event: SyncEvent) => void) => {
        syncObserver = observer
        return () => undefined
      }),
    }
    items = { addObserver: jest.fn().mockReturnValue(() => undefined) }
    session = {
      isSignedIn: jest.fn().mockReturnValue(true),
      isUserMissingKeyPair: jest.fn().mockReturnValue(false),
      getSureUser: jest.fn().mockReturnValue({ uuid: 'user-1' }),
      getPublicKey: jest.fn().mockReturnValue('encryption-public-key'),
      getSigningPublicKey: jest.fn().mockReturnValue('signing-public-key'),
    }
    singletons = {
      findSingleton: jest.fn().mockReturnValue(undefined),
      findOrCreateSingleton: jest.fn().mockResolvedValue(created),
    }
  })

  it('creates the self contact even though the Vaults internal feature is disabled', async () => {
    // Guards the fixture: if this flag were somehow on, the test could not prove the gate is gone.
    expect(InternalFeatureService.get().isFeatureEnabled(InternalFeature.Vaults)).toBe(false)

    const result = await createManager().getOrCreateSelfContact()

    expect(result).toBe(created)
    expect(singletons.findOrCreateSingleton).toHaveBeenCalledTimes(1)

    const [, contentType, content] = singletons.findOrCreateSingleton.mock.calls[0]
    expect(contentType).toBe(ContentType.TYPES.TrustedContact)
    expect(content.isMe).toBe(true)
    expect(content.name).toBe('Me')
    // The server-side user uuid, so the contact matches a membership already recorded for this
    // account instead of orphaning it.
    expect(content.contactUuid).toBe('user-1')
    expect(content.publicKeySet.encryption).toBe('encryption-public-key')
    expect(content.publicKeySet.signing).toBe('signing-public-key')
  })

  it('exposes the created contact on selfContact', async () => {
    const manager = createManager()

    await manager.getOrCreateSelfContact()

    expect(manager.selfContact).toBe(created)
  })

  it('adopts an existing self contact rather than creating a second one', async () => {
    const existing = { uuid: 'existing', contactUuid: 'user-1', isMe: true } as unknown as TrustedContactInterface
    singletons.findSingleton.mockReturnValue(existing)

    const result = await createManager().getOrCreateSelfContact()

    expect(result).toBe(existing)
    expect(singletons.findOrCreateSingleton).not.toHaveBeenCalled()
  })

  it('creates nothing when the user is not signed in', async () => {
    session.isSignedIn.mockReturnValue(false)

    expect(await createManager().getOrCreateSelfContact()).toBeUndefined()
    expect(singletons.findOrCreateSingleton).not.toHaveBeenCalled()
  })

  it('creates nothing when the account has no key pair, since there would be no keys to publish', async () => {
    session.isUserMissingKeyPair.mockReturnValue(true)

    expect(await createManager().getOrCreateSelfContact()).toBeUndefined()
    expect(singletons.findOrCreateSingleton).not.toHaveBeenCalled()
  })

  it('shares one creation between concurrent callers instead of racing them', async () => {
    const manager = createManager()

    const [first, second] = await Promise.all([manager.getOrCreateSelfContact(), manager.getOrCreateSelfContact()])

    expect(first).toBe(created)
    expect(second).toBe(created)
    expect(singletons.findOrCreateSingleton).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed creation instead of wedging for the rest of the session', async () => {
    singletons.findOrCreateSingleton.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(created)
    const manager = createManager()

    await expect(manager.getOrCreateSelfContact()).rejects.toThrow('offline')

    expect(await manager.getOrCreateSelfContact()).toBe(created)
    expect(singletons.findOrCreateSingleton).toHaveBeenCalledTimes(2)
  })

  it('creates the self contact when a sync completes with all items uploaded', async () => {
    createManager()

    syncObserver(SyncEvent.SyncCompletedWithAllItemsUploaded)
    await Promise.resolve()
    await Promise.resolve()

    expect(singletons.findOrCreateSingleton).toHaveBeenCalledTimes(1)
  })
})
