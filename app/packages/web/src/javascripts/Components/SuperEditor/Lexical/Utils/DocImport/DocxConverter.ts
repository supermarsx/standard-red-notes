/**
 * DOCX → Super import converter (web-only).
 *
 * Reuses the existing HTML→Super seam: `mammoth` turns the binary .docx
 * (OOXML zip) into HTML — with images inlined as base64 data URIs so they
 * survive — and the injected `convertHTMLToSuper(html)` routes that HTML into a
 * Lexical/Super note exactly like `HTMLConverter`. No bespoke Lexical-import
 * code.
 *
 * `mammoth` is loaded with a dynamic `import()` so it stays code-split and is
 * pulled in only when a real .docx is imported. It is a WEB-ONLY dependency
 * (registered via `WebDependencies`, never in `ui-services`) so the mobile
 * bundle stays clean.
 */
import { parseFileName } from '@standardnotes/utils'
import { Converter } from '@standardnotes/ui-services'

export const DOCX_IMPORT_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export class DocxConverter implements Converter {
  getImportType(): string {
    return 'docx'
  }

  getFileExtension(): string {
    return 'docx'
  }

  getSupportedFileTypes(): string[] {
    return [DOCX_IMPORT_MIME_TYPE]
  }

  /**
   * A .docx is a zip; read as text it still begins with the local-file-header
   * magic "PK". Guards against a file mislabeled .docx that isn't a zip.
   */
  isContentValid(content: string): boolean {
    return content.startsWith('PK')
  }

  convert: Converter['convert'] = async (file, { insertNote, convertHTMLToSuper, canUseSuper }) => {
    if (!canUseSuper) {
      throw new Error('Importing a Word (.docx) document requires the Super editor')
    }

    const arrayBuffer = await file.arrayBuffer()

    const mammoth = (await import('mammoth')).default
    // `images.dataUri` inlines embedded images as `<img src="data:…base64">`,
    // which the HTML→Super path maps to image nodes.
    const result = await mammoth.convertToHtml({ arrayBuffer }, { convertImage: mammoth.images.dataUri })
    const html = result.value

    const text = convertHTMLToSuper(html)

    const { name } = parseFileName(file.name)
    const createdAtDate = file.lastModified ? new Date(file.lastModified) : new Date()
    const updatedAtDate = file.lastModified ? new Date(file.lastModified) : new Date()

    const note = await insertNote({
      createdAt: createdAtDate,
      updatedAt: updatedAtDate,
      title: name,
      text,
      useSuperIfPossible: true,
    })

    return {
      successful: [note],
      errored: [],
    }
  }
}
