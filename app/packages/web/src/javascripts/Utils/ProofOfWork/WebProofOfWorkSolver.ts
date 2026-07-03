import { ProofOfWorkSolverInterface } from '@standardnotes/snjs'

import { ThreadedPowSolver } from './ThreadedPowSolver'

// Must match the auth server's PROOF_OF_WORK_ALGORITHM. The solver only knows
// how to answer this one scheme (SHA-256, leading zero bits); anything else is
// rejected so a future/unknown algorithm surfaces as a clear error rather than a
// silently-wrong solution.
const SUPPORTED_ALGORITHM = 'sha256-leading-zero-bits'

/**
 * Standard Red Notes: web/desktop implementation of the proof-of-work solver
 * that SessionManager uses to answer a `proof-of-work-required` challenge during
 * register / sign-in. Delegates to ThreadedPowSolver, which runs the CPU-bound
 * nonce search in a Web Worker (falling back to the main thread where Workers
 * are unavailable) so the UI never blocks.
 */
export class WebProofOfWorkSolver implements ProofOfWorkSolverInterface {
  private readonly solver = new ThreadedPowSolver()

  async solve(seed: string, difficulty: number, algorithm: string): Promise<string> {
    if (algorithm !== SUPPORTED_ALGORITHM) {
      throw new Error(`Unsupported proof-of-work algorithm: ${algorithm}`)
    }

    return this.solver.solve(seed, difficulty)
  }

  /** Release the underlying worker. Call when the owning application tears down. */
  destroy(): void {
    this.solver.destroy()
  }
}
