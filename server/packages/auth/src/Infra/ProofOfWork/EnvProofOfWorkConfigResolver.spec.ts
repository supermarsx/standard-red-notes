import { ProofOfWorkConfig, ProofOfWorkOverlay } from '../../Domain/ProofOfWork/ProofOfWorkConfig'

import { EnvProofOfWorkConfigResolver } from './EnvProofOfWorkConfigResolver'

describe('EnvProofOfWorkConfigResolver', () => {
  const baseline: ProofOfWorkConfig = {
    register: { enabled: true, difficulty: 12, ttlSeconds: 600 },
    signIn: { enabled: true, difficulty: 16, ttlSeconds: 600, mode: 'adaptive', adaptiveThreshold: 3 },
  }

  it('returns the env baseline when there is no overlay', async () => {
    const resolver = new EnvProofOfWorkConfigResolver(baseline, () => Promise.resolve(undefined))

    const config = await resolver.resolve()

    expect(config).toEqual(baseline)
  })

  it('lets a persisted admin overlay override individual knobs (persisted -> env -> default)', async () => {
    const overlay: ProofOfWorkOverlay = {
      registerEnabled: false,
      signInMode: 'always',
      signInDifficulty: 20,
      signInAdaptiveThreshold: 5,
    }
    const resolver = new EnvProofOfWorkConfigResolver(baseline, () => Promise.resolve(overlay))

    const config = await resolver.resolve()

    expect(config.register.enabled).toBe(false)
    expect(config.register.difficulty).toBe(12) // untouched -> baseline
    expect(config.signIn.mode).toBe('always')
    expect(config.signIn.difficulty).toBe(20)
    expect(config.signIn.adaptiveThreshold).toBe(5)
  })

  it('clamps overlay difficulty into a sane range', async () => {
    const resolver = new EnvProofOfWorkConfigResolver(baseline, () =>
      Promise.resolve({ signInDifficulty: 999, registerDifficulty: -5 }),
    )

    const config = await resolver.resolve()

    expect(config.signIn.difficulty).toBe(32)
    expect(config.register.difficulty).toBe(0)
  })

  it('ignores an invalid signInMode value', async () => {
    const resolver = new EnvProofOfWorkConfigResolver(baseline, () =>
      Promise.resolve({ signInMode: 'nonsense' as unknown as 'always' }),
    )

    const config = await resolver.resolve()

    expect(config.signIn.mode).toBe('adaptive')
  })

  it('degrades to the baseline when the overlay getter throws', async () => {
    const resolver = new EnvProofOfWorkConfigResolver(baseline, () => Promise.reject(new Error('bad file')))

    const config = await resolver.resolve()

    expect(config).toEqual(baseline)
  })

  it('does not mutate the shared baseline object across resolves', async () => {
    const resolver = new EnvProofOfWorkConfigResolver(baseline, () => Promise.resolve({ registerEnabled: false }))

    await resolver.resolve()

    expect(baseline.register.enabled).toBe(true)
  })
})
