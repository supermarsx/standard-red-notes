import { createElement, type ComponentType, type ReactNode } from 'react'
import type {
  ViewProps,
  LinkProps,
  PathProps,
  TextProps,
  SVGProps,
  ImageWithSrcProp,
  PageProps,
} from '@react-pdf/renderer'
import type { FontFamily } from './FontConfig'
import { PDF_BASE_FONT_SIZE, PDF_BLOCK_GAP, PDF_PAGE_PADDING } from './PDFLayoutConstants'
import {
  hasBandAt,
  pageStartOffset,
  resolveFont,
  type HeaderFooterStyle,
  type PageLayoutOptions,
} from '../DocExport/PageLayoutOptions'
import { formatPdfPageNumber, substitutePageTokens } from './pageLayoutRender'

/** Fixed-position font styling for the running header/footer bands. */
const PDF_HEADER_FOOTER_FONT_SIZE = 9
const PDF_HEADER_FOOTER_COLOR = '#555555'
/** Extra top/bottom padding reserved for a header/footer band so it never overlaps content. */
const PDF_HEADER_FOOTER_RESERVE = 22

export type PDFDataNode =
  | ((
      | ({ type: 'View' } & Omit<ViewProps, 'children'>)
      | ({ type: 'Text' } & Omit<TextProps, 'children'>)
      | ({ type: 'Link' } & Omit<LinkProps, 'children'>)
      | ({ type: 'Image' } & Omit<ImageWithSrcProp, 'children'>)
      | ({ type: 'Svg' } & Omit<SVGProps, 'children'>)
      | ({ type: 'Path' } & Omit<PathProps, 'children'>)
    ) & {
      children?: PDFDataNode[] | string
    })
  | null

type ReactPDFModule = typeof import('@react-pdf/renderer')

export type PDFRendererRuntime = Pick<
  ReactPDFModule,
  'Document' | 'Page' | 'View' | 'Text' | 'Link' | 'Image' | 'Svg' | 'Path' | 'pdf'
>

const createRuntimeElement = (component: unknown, props: unknown, children?: ReactNode): ReactNode =>
  createElement(component as ComponentType<Record<string, unknown>>, props as Record<string, unknown>, children)

/**
 * The renderer-independent document builder is shared by the production worker
 * and artifact tests. Keeping the React-PDF runtime injectable lets Jest load
 * its ESM-only build natively without replacing the production layout logic.
 */
const renderDataNode = (runtime: PDFRendererRuntime, node: PDFDataNode, key: number): ReactNode => {
  if (!node) {
    return null
  }

  const { type, children, ...props } = node
  const renderedChildren =
    typeof children === 'string' ? children : children?.map((child, index) => renderDataNode(runtime, child, index))

  switch (type) {
    case 'View':
      return createRuntimeElement(runtime.View, { ...props, key }, renderedChildren)
    case 'Text':
      return createRuntimeElement(runtime.Text, { ...props, key }, renderedChildren)
    case 'Link':
      return createRuntimeElement(runtime.Link, { ...props, key }, renderedChildren)
    case 'Image':
      return createRuntimeElement(runtime.Image, { ...props, key })
    case 'Svg':
      return createRuntimeElement(runtime.Svg, { ...props, key }, renderedChildren)
    case 'Path':
      return createRuntimeElement(runtime.Path, { ...props, key })
  }
}

/**
 * The react-pdf `<Text>` style a band's style contributes, overriding the band's
 * default font size / color. Font family resolves to a standard-14 name (no
 * registration); an absent field is omitted so the band inherits its default.
 */
const hfTextStyle = (style: HeaderFooterStyle): TextProps['style'] => {
  const resolved: Record<string, unknown> = {}
  const font = resolveFont(style.fontId).pdf
  if (font) {
    resolved.fontFamily = font
  }
  if (style.fontSizePt != null) {
    resolved.fontSize = style.fontSizePt
  }
  if (style.bold) {
    resolved.fontWeight = 'bold'
  }
  if (style.italic) {
    resolved.fontStyle = 'italic'
  }
  if (style.underline) {
    resolved.textDecoration = 'underline'
  }
  if (style.color) {
    resolved.color = style.color
  }
  return resolved as TextProps['style']
}

const renderHeaderFooterBand = (
  runtime: PDFRendererRuntime,
  location: 'header' | 'footer',
  options: PageLayoutOptions,
): ReactNode => {
  if (!hasBandAt(options, location)) {
    return null
  }
  const section = location === 'header' ? options.header : options.footer
  const pageNumber = options.pageNumber && options.pageNumber.location === location ? options.pageNumber : undefined
  const offset = pageStartOffset(options)
  const edge = location === 'header' ? { top: PDF_PAGE_PADDING / 2 } : { bottom: PDF_PAGE_PADDING / 2 }
  const children: ReactNode[] = []

  if (section) {
    children.push(
      createElement(runtime.Text, {
        fixed: true,
        style: { textAlign: section.align, width: '100%', ...hfTextStyle(section) },
        render: ({ pageNumber: current, totalPages }) =>
          substitutePageTokens(section.text, current, totalPages, offset),
      }),
    )
  }
  if (pageNumber) {
    children.push(
      createElement(runtime.Text, {
        fixed: true,
        style: { textAlign: pageNumber.align, width: '100%' },
        render: ({ pageNumber: current, totalPages }) =>
          formatPdfPageNumber(pageNumber.format, current + offset, totalPages),
      }),
    )
  }

  return createElement(
    runtime.View,
    {
      fixed: true,
      style: {
        position: 'absolute',
        left: PDF_PAGE_PADDING,
        right: PDF_PAGE_PADDING,
        ...edge,
        fontSize: PDF_HEADER_FOOTER_FONT_SIZE,
        color: PDF_HEADER_FOOTER_COLOR,
        gap: 2,
      },
    },
    ...children,
  )
}

const createPDFDocument = (
  runtime: PDFRendererRuntime,
  nodes: PDFDataNode[],
  pageSize: PageProps['size'],
  options?: PageLayoutOptions,
) => {
  const hasHeader = options != null && hasBandAt(options, 'header')
  const hasFooter = options != null && hasBandAt(options, 'footer')
  const pageChildren: ReactNode[] = []

  if (options) {
    pageChildren.push(renderHeaderFooterBand(runtime, 'header', options))
    pageChildren.push(renderHeaderFooterBand(runtime, 'footer', options))
  }
  pageChildren.push(...nodes.map((node, index) => renderDataNode(runtime, node, index)))

  return createElement(
    runtime.Document,
    null,
    createElement(
      runtime.Page,
      {
        size: pageSize,
        style: {
          paddingTop: PDF_PAGE_PADDING + (hasHeader ? PDF_HEADER_FOOTER_RESERVE : 0),
          paddingBottom: PDF_PAGE_PADDING + (hasFooter ? PDF_HEADER_FOOTER_RESERVE : 0),
          paddingHorizontal: PDF_PAGE_PADDING,
          fontSize: PDF_BASE_FONT_SIZE,
          gap: PDF_BLOCK_GAP,
        },
      },
      ...pageChildren,
    ),
  )
}

export const renderPDFWithRuntime = (
  runtime: PDFRendererRuntime,
  nodes: PDFDataNode[],
  pageSize: PageProps['size'],
  _fontFamilies: FontFamily[],
  _useCustomFonts: boolean = false,
  options?: PageLayoutOptions,
): Promise<Blob> => runtime.pdf(createPDFDocument(runtime, nodes, pageSize, options)).toBlob()
