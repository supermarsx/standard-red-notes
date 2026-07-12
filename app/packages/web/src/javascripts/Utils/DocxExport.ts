/**
 * Thin compatibility shim for note DOCX/ODT export.
 *
 * The former Word-only `altChunk` hack (a `.docx` whose body was a single
 * `<w:altChunk>` referencing an embedded HTML part) has been REPLACED by a
 * structured OOXML generator that opens faithfully in Word, LibreOffice, Google
 * Docs and Pages — plus a new ODT generator. Both consume the shared DocModel.
 *
 * This module now just re-exports the MIME constants and the generators from
 * their canonical home so existing import sites keep working.
 */
export { DOCX_MIME_TYPE, buildDocxBlob } from '@/Components/SuperEditor/Lexical/Utils/DocExport/DocxGenerator'
export { ODT_MIME_TYPE, buildOdtBlob } from '@/Components/SuperEditor/Lexical/Utils/DocExport/OdtGenerator'
