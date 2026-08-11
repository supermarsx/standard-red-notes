import * as ReactPDFRenderer from '@react-pdf/renderer'
import { registerPDFFonts, type FontFamily } from './FontConfig'
import { renderPDFWithRuntime, type PDFDataNode } from './PDFRendererCore'
import type { PageLayoutOptions } from '../DocExport/PageLayoutOptions'

export type { PDFDataNode } from './PDFRendererCore'

export const renderPDF = (
  nodes: PDFDataNode[],
  pageSize: ReactPDFRenderer.PageProps['size'],
  fontFamilies: FontFamily[],
  useCustomFonts: boolean = false,
  options?: PageLayoutOptions,
) => {
  if (useCustomFonts) {
    registerPDFFonts(fontFamilies)
  }
  return renderPDFWithRuntime(ReactPDFRenderer, nodes, pageSize, fontFamilies, useCustomFonts, options)
}
