/**
 * Lazily-loaded PDF.js entry point.
 *
 * We import the *legacy* prebuilt ESM build (it avoids top-level `await`, which
 * keeps it compatible with our webpack/babel pipeline) and point the worker at a
 * locally-bundled copy of `pdf.worker.min.mjs`. The worker file is emitted as an
 * `asset/resource` by webpack (see web.webpack.config.js), so it is served from
 * our own origin and the viewer works fully offline (no CDN).
 *
 * The whole module is loaded via dynamic `import()` from the viewer component so
 * the (large) PDF.js bundle is code-split and only fetched when a PDF is opened.
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
// Emitted as asset/resource -> resolves to the public URL of the worker file.
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'

let configured = false

export function getPdfjs(): typeof import('pdfjs-dist') {
  if (!configured) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pdfjsLib as any).GlobalWorkerOptions.workerSrc = pdfWorkerUrl as unknown as string
    configured = true
  }
  return pdfjsLib as unknown as typeof import('pdfjs-dist')
}

export type PDFDocumentProxy = import('pdfjs-dist').PDFDocumentProxy
export type PDFPageProxy = import('pdfjs-dist').PDFPageProxy
