import {
  Document,
  Page,
  View,
  Text,
  pdf,
  Link,
  Image,
  Svg,
  Path,
  ViewProps,
  LinkProps,
  PathProps,
  TextProps,
  SVGProps,
  ImageWithSrcProp,
  PageProps,
} from '@react-pdf/renderer'
import { expose } from 'comlink'
import { FontFamily, registerPDFFonts } from './FontConfig'
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

/**
 * The react-pdf `<Text>` style a band's style contributes, overriding the band's
 * default font size / color. Font family resolves to a standard-14 name (no
 * registration); an absent field is omitted so the band inherits its default.
 */
const hfTextStyle = (style: HeaderFooterStyle): TextProps['style'] => {
  const s: Record<string, unknown> = {}
  const font = resolveFont(style.fontId).pdf
  if (font) {
    s.fontFamily = font
  }
  if (style.fontSizePt != null) {
    s.fontSize = style.fontSizePt
  }
  if (style.bold) {
    s.fontWeight = 'bold'
  }
  if (style.italic) {
    s.fontStyle = 'italic'
  }
  if (style.underline) {
    s.textDecoration = 'underline'
  }
  if (style.color) {
    s.color = style.color
  }
  return s as TextProps['style']
}

export type PDFDataNode =
  | ((
      | ({
          type: 'View'
        } & Omit<ViewProps, 'children'>)
      | ({
          type: 'Text'
        } & Omit<TextProps, 'children'>)
      | ({
          type: 'Link'
        } & Omit<LinkProps, 'children'>)
      | ({
          type: 'Image'
        } & Omit<ImageWithSrcProp, 'children'>)
      | ({
          type: 'Svg'
        } & Omit<SVGProps, 'children'>)
      | ({
          type: 'Path'
        } & Omit<PathProps, 'children'>)
    ) & {
      children?: PDFDataNode[] | string
    })
  | null

const Node = ({ node }: { node: PDFDataNode }) => {
  if (!node) {
    return null
  }

  const children =
    typeof node.children === 'string'
      ? node.children
      : node.children?.map((child, index) => {
          return <Node node={child} key={index} />
        })

  switch (node.type) {
    case 'View':
      return <View {...node}>{children}</View>
    case 'Text':
      return <Text {...node}>{children}</Text>
    case 'Link':
      return <Link {...node}>{children}</Link>
    case 'Image':
      return <Image {...node} />
    case 'Svg':
      return <Svg {...node}>{children}</Svg>
    case 'Path': {
      const { children: _, ...props } = node
      return <Path {...props} />
    }
  }
}

/**
 * The fixed (repeated-on-every-page) header or footer band, built worker-side
 * from the serializable options — the `render` callbacks can't cross the comlink
 * boundary, so they MUST be constructed here. Returns null when the band carries
 * nothing at this location.
 */
const HeaderFooterBand = ({ location, options }: { location: 'header' | 'footer'; options: PageLayoutOptions }) => {
  if (!hasBandAt(options, location)) {
    return null
  }
  const section = location === 'header' ? options.header : options.footer
  const pageNumber = options.pageNumber && options.pageNumber.location === location ? options.pageNumber : undefined
  const offset = pageStartOffset(options)
  const edge = location === 'header' ? { top: PDF_PAGE_PADDING / 2 } : { bottom: PDF_PAGE_PADDING / 2 }
  return (
    <View
      fixed
      style={{
        position: 'absolute',
        left: PDF_PAGE_PADDING,
        right: PDF_PAGE_PADDING,
        ...edge,
        fontSize: PDF_HEADER_FOOTER_FONT_SIZE,
        color: PDF_HEADER_FOOTER_COLOR,
        gap: 2,
      }}
    >
      {section ? (
        <Text
          fixed
          style={{ textAlign: section.align, width: '100%', ...hfTextStyle(section) }}
          render={({ pageNumber: current, totalPages }) =>
            substitutePageTokens(section.text, current, totalPages, offset)
          }
        />
      ) : null}
      {pageNumber ? (
        <Text
          fixed
          style={{ textAlign: pageNumber.align, width: '100%' }}
          render={({ pageNumber: current, totalPages }) =>
            formatPdfPageNumber(pageNumber.format, current + offset, totalPages)
          }
        />
      ) : null}
    </View>
  )
}

const PDFDocument = ({
  nodes,
  pageSize,
  options,
}: {
  nodes: PDFDataNode[]
  pageSize: PageProps['size']
  options?: PageLayoutOptions
}) => {
  const hasHeader = options != null && hasBandAt(options, 'header')
  const hasFooter = options != null && hasBandAt(options, 'footer')
  return (
    <Document>
      <Page
        size={pageSize}
        style={{
          paddingTop: PDF_PAGE_PADDING + (hasHeader ? PDF_HEADER_FOOTER_RESERVE : 0),
          paddingBottom: PDF_PAGE_PADDING + (hasFooter ? PDF_HEADER_FOOTER_RESERVE : 0),
          paddingHorizontal: PDF_PAGE_PADDING,
          fontSize: PDF_BASE_FONT_SIZE,
          gap: PDF_BLOCK_GAP,
        }}
      >
        {options ? <HeaderFooterBand location="header" options={options} /> : null}
        {options ? <HeaderFooterBand location="footer" options={options} /> : null}
        {nodes.map((node, index) => {
          return <Node node={node} key={index} />
        })}
      </Page>
    </Document>
  )
}

const renderPDF = (
  nodes: PDFDataNode[],
  pageSize: PageProps['size'],
  fontFamilies: FontFamily[],
  useCustomFonts: boolean = false,
  options?: PageLayoutOptions,
) => {
  if (useCustomFonts) {
    registerPDFFonts(fontFamilies)
  }
  return pdf(<PDFDocument pageSize={pageSize} nodes={nodes} options={options} />).toBlob()
}

expose({
  renderPDF,
})

export type PDFWorkerInterface = {
  renderPDF: typeof renderPDF
}
