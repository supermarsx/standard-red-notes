/**
 * Build a real .docx (OpenXML/OOXML) Word document from an HTML string, with no
 * extra dependencies — assembled with @zip.js/zip.js, which the export pipeline
 * already uses.
 *
 * Technique: the document body contains a single `<w:altChunk>` that references
 * an embedded HTML part (`word/afchunk.html`). Word reads the altChunk and
 * imports the HTML, so the document keeps the note's headings, bold/italic,
 * lists, tables, links, and inline (base64) images. This reuses the existing
 * HTML export for high fidelity in Microsoft Word. (Some viewers that don't
 * implement altChunk import — e.g. older LibreOffice/Google Docs — may show the
 * raw imported content less faithfully; Word is the primary target for .docx.)
 */

export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="html" ContentType="text/html"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:altChunk r:id="htmlChunk"/>
    <w:sectPr/>
  </w:body>
</w:document>`

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="htmlChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="afchunk.html"/>
</Relationships>`

export const buildDocxBlobFromHtml = async (html: string): Promise<Blob> => {
  const zip = await import('@zip.js/zip.js')
  const zipFS = new zip.fs.FS()
  const { root } = zipFS

  root.addText('[Content_Types].xml', CONTENT_TYPES_XML)

  const rootRels = root.addDirectory('_rels')
  rootRels.addText('.rels', ROOT_RELS_XML)

  const word = root.addDirectory('word')
  word.addText('document.xml', DOCUMENT_XML)
  word.addText('afchunk.html', html)

  const wordRels = word.addDirectory('_rels')
  wordRels.addText('document.xml.rels', DOCUMENT_RELS_XML)

  const zipped = await zipFS.exportBlob()
  // Re-tag the package with the Word MIME type (exportBlob yields application/zip).
  return new Blob([zipped], { type: DOCX_MIME_TYPE })
}
