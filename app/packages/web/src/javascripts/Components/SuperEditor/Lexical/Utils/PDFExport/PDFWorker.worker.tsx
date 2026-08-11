import { expose } from 'comlink'
import { renderPDF } from './PDFRenderer'

export type { PDFDataNode } from './PDFRenderer'

expose({
  renderPDF,
})

export type PDFWorkerInterface = {
  renderPDF: typeof renderPDF
}
