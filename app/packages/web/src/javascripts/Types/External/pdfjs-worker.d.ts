// The PDF.js worker is imported for its emitted asset URL (webpack asset/resource).
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' {
  const workerSrc: string
  export default workerSrc
}

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  // Re-export the published PDF.js types for the legacy build entry.
  export * from 'pdfjs-dist'
}
