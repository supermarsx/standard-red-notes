// Tests for WebProofOfWorkSolver: it must reject an unknown algorithm and, for the
// supported scheme, return a nonce that actually solves the challenge (the value the
// client attaches to its register / sign-in resubmit). jsdom has no Worker, so the
// underlying ThreadedPowSolver takes its main-thread fallback here.

import { hashMeetsDifficulty } from './powSolver'
import { WebProofOfWorkSolver } from './WebProofOfWorkSolver'

describe('WebProofOfWorkSolver', () => {
  it('solves the supported algorithm and returns a nonce meeting the difficulty', async () => {
    const solver = new WebProofOfWorkSolver()

    const seed = 'web-solver-seed'
    const nonce = await solver.solve(seed, 8, 'sha256-leading-zero-bits')

    expect(typeof nonce).toBe('string')
    expect(hashMeetsDifficulty(seed, nonce, 8)).toBe(true)

    solver.destroy()
  })

  it('rejects an unsupported algorithm rather than returning a wrong solution', async () => {
    const solver = new WebProofOfWorkSolver()

    await expect(solver.solve('seed', 8, 'argon2-something-else')).rejects.toThrow(/unsupported proof-of-work algorithm/i)

    solver.destroy()
  })
})
