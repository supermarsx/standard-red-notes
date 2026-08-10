import { TimerInterface } from '@standardnotes/time'

import { InMemoryValetTokenRepository } from './InMemoryValetTokenRepository'

describe('InMemoryValetTokenRepository', () => {
  let now: number
  let timer: TimerInterface

  beforeEach(() => {
    now = 1_000
    timer = { getTimestampInSeconds: jest.fn(() => now) } as unknown as jest.Mocked<TimerInterface>
  })

  it('reports new tokens as unused and marked tokens as used', async () => {
    const repository = new InMemoryValetTokenRepository(timer)

    expect(await repository.isUsed('valet-token')).toBe(false)
    await repository.markAsUsed('valet-token')
    expect(await repository.isUsed('valet-token')).toBe(true)
  })

  it('keeps tokens isolated from one another', async () => {
    const repository = new InMemoryValetTokenRepository(timer)

    await repository.markAsUsed('used-token')

    expect(await repository.isUsed('used-token')).toBe(true)
    expect(await repository.isUsed('unused-token')).toBe(false)
  })

  it('expires replay state after the same one-day window as Redis', async () => {
    const repository = new InMemoryValetTokenRepository(timer)
    await repository.markAsUsed('valet-token')

    now += 86_399
    expect(await repository.isUsed('valet-token')).toBe(true)

    now += 1
    expect(await repository.isUsed('valet-token')).toBe(false)
  })

  it('lazily reclaims many expired one-use tokens when traffic continues', async () => {
    const repository = new InMemoryValetTokenRepository(timer)
    for (let index = 0; index < 1_000; index += 1) {
      await repository.markAsUsed(`expired-${index}`)
    }

    now += 86_400
    await repository.markAsUsed('current-token')

    const entries = (repository as unknown as { usedUntil: Map<string, number> }).usedUntil
    expect(entries.size).toBe(1)
    expect(entries.has('current-token')).toBe(true)
  })
})
