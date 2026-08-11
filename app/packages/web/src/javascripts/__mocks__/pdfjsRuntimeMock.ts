/**
 * CommonJS Jest boundary for PDF.js 6's ESM-only browser runtime.
 *
 * Production never resolves this file: webpack imports the pinned PDF.js
 * package directly. The mock deliberately throws if an incidental unit test
 * tries to render a PDF, so PDF behavior cannot silently pass against a fake
 * document implementation.
 */
export const GlobalWorkerOptions = { workerSrc: '' }

export function getDocument(): never {
  throw new Error('PDF.js rendering is unavailable in CommonJS Jest; use the dedicated PDF artifact test harness')
}
