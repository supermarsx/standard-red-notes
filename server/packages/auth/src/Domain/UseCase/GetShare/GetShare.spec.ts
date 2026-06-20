import { UniqueEntityId } from '@standardnotes/domain-core'

import { Share } from '../../Share/Share'
import { ShareRepositoryInterface } from '../../Share/ShareRepositoryInterface'

import { GetShare } from './GetShare'

describe('GetShare', () => {
  let shareRepository: ShareRepositoryInterface

  const shareId = '11111111-1111-1111-1111-111111111111'

  const createShare = (
    revoked: boolean,
    overrides: Partial<{
      oneTimeView: boolean
      viewExpiresMinutes: number | null
      firstOpenedAt: Date | null
    }> = {},
  ) =>
    Share.create(
      {
        userUuid: '00000000-0000-0000-0000-000000000000',
        type: 'note',
        encryptedPayload: 'cipher',
        nickname: 'nick',
        createdAt: new Date(1),
        revoked,
        oneTimeView: overrides.oneTimeView ?? false,
        viewExpiresMinutes: overrides.viewExpiresMinutes ?? null,
        firstOpenedAt: overrides.firstOpenedAt ?? null,
      },
      new UniqueEntityId(shareId),
    ).getValue()

  const createUseCase = () => new GetShare(shareRepository)

  beforeEach(() => {
    shareRepository = {} as jest.Mocked<ShareRepositoryInterface>
    shareRepository.findById = jest.fn().mockResolvedValue(createShare(false))
    shareRepository.markFirstOpenedAtomically = jest.fn().mockResolvedValue(true)
    shareRepository.markRevoked = jest.fn().mockResolvedValue(undefined)
  })

  it('should return type and encrypted payload for an active share', async () => {
    const result = await createUseCase().execute({ shareId })

    expect(result.isFailed()).toBe(false)
    const value = result.getValue()
    expect(value.type).toEqual('note')
    expect(value.encryptedPayload).toEqual('cipher')
    // Must never leak the owning user uuid.
    expect(value).not.toHaveProperty('userUuid')
  })

  it('should fail (not found) if the share does not exist', async () => {
    shareRepository.findById = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ shareId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Share not found')
  })

  it('should fail (not found) if the share is revoked', async () => {
    shareRepository.findById = jest.fn().mockResolvedValue(createShare(true))

    const result = await createUseCase().execute({ shareId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Share not found')
  })

  it('should NOT touch the consume helpers for a normal (non-burn) share', async () => {
    const result = await createUseCase().execute({ shareId })

    expect(result.isFailed()).toBe(false)
    expect(shareRepository.markFirstOpenedAtomically).not.toHaveBeenCalled()
    expect(shareRepository.markRevoked).not.toHaveBeenCalled()
  })

  describe('one-time-view (burn after reading)', () => {
    beforeEach(() => {
      shareRepository.findById = jest.fn().mockResolvedValue(createShare(false, { oneTimeView: true }))
    })

    it('should serve the payload and consume the share on the first open', async () => {
      const result = await createUseCase().execute({ shareId })

      expect(result.isFailed()).toBe(false)
      expect(result.getValue().encryptedPayload).toEqual('cipher')
      expect(shareRepository.markFirstOpenedAtomically).toHaveBeenCalledTimes(1)
      expect(shareRepository.markRevoked).toHaveBeenCalledTimes(1)
    })

    it('should fail on a second open (lost the atomic race)', async () => {
      shareRepository.markFirstOpenedAtomically = jest.fn().mockResolvedValue(false)

      const result = await createUseCase().execute({ shareId })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Share not found')
      expect(shareRepository.markRevoked).not.toHaveBeenCalled()
    })

    it('should fail if the share was already opened (firstOpenedAt set, no window)', async () => {
      shareRepository.findById = jest
        .fn()
        .mockResolvedValue(createShare(false, { oneTimeView: true, firstOpenedAt: new Date(1) }))

      const result = await createUseCase().execute({ shareId })

      expect(result.isFailed()).toBe(true)
      expect(shareRepository.markFirstOpenedAtomically).not.toHaveBeenCalled()
    })
  })

  describe('time-limited view (expire N minutes after first open)', () => {
    it('should serve and stamp the first open without consuming when a window is set', async () => {
      shareRepository.findById = jest
        .fn()
        .mockResolvedValue(createShare(false, { oneTimeView: true, viewExpiresMinutes: 10 }))

      const result = await createUseCase().execute({ shareId })

      expect(result.isFailed()).toBe(false)
      expect(shareRepository.markFirstOpenedAtomically).toHaveBeenCalledTimes(1)
      // A windowed share must stay available until the window elapses.
      expect(shareRepository.markRevoked).not.toHaveBeenCalled()
    })

    it('should serve within the window after the first open', async () => {
      const openedAt = new Date(Date.now() - 5 * 60_000) // 5 minutes ago
      shareRepository.findById = jest
        .fn()
        .mockResolvedValue(createShare(false, { viewExpiresMinutes: 10, firstOpenedAt: openedAt }))

      const result = await createUseCase().execute({ shareId })

      expect(result.isFailed()).toBe(false)
      expect(result.getValue().encryptedPayload).toEqual('cipher')
      expect(shareRepository.markRevoked).not.toHaveBeenCalled()
    })

    it('should expire and fail after the window elapses', async () => {
      const openedAt = new Date(Date.now() - 20 * 60_000) // 20 minutes ago
      shareRepository.findById = jest
        .fn()
        .mockResolvedValue(createShare(false, { viewExpiresMinutes: 10, firstOpenedAt: openedAt }))

      const result = await createUseCase().execute({ shareId })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Share not found')
      expect(shareRepository.markRevoked).toHaveBeenCalledTimes(1)
    })
  })
})
