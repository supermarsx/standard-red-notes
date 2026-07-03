// Message protocol shared between the main thread and the Proof-of-Work Web Worker
// (powSolver.worker.ts). Kept in its own dependency-free module so both sides
// import the exact same types without pulling the worker's runtime into the main
// bundle (or vice-versa).

/** Messages posted FROM the main thread TO the worker. */
export type PowSolverWorkerRequest = { type: 'solve'; requestId: number; seed: string; difficulty: number }

/** Messages posted FROM the worker BACK TO the main thread. */
export type PowSolverWorkerResponse =
  | { type: 'solved'; requestId: number; nonce: string }
  | { type: 'error'; requestId: number; message: string }
