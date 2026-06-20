/**
 * Standard Red Notes: privacy-focused image metadata stripping for uploads.
 *
 * Strips EXIF/GPS/XMP and other ancillary metadata from images BEFORE they are
 * read/encrypted/uploaded, so private data (camera serials, GPS coordinates,
 * timestamps, thumbnails) never leaves the device.
 *
 * Strategy per format:
 *  - JPEG: LOSSLESS. We walk the JFIF marker stream and drop the metadata
 *    segments (APP1 = EXIF/XMP, APP13 = Photoshop/IPTC, and the COM comment
 *    marker) without re-encoding the pixel data. SOI/EOI and all scan data are
 *    preserved bit-for-bit, so there is zero quality loss.
 *  - PNG: LOSSLESS. We parse the chunk stream and drop ancillary text/metadata
 *    chunks (tEXt/zTXt/iTXt/eXIf/tIME) while keeping all critical chunks
 *    (IHDR/PLTE/IDAT/IEND etc.) untouched, so the decoded pixels are identical.
 *  - WebP / everything else: no safe lossless container rewrite is implemented,
 *    so we fall back to a canvas re-encode (decode -> draw -> re-encode). This
 *    DROPS all metadata but is LOSSY for already-compressed formats and may
 *    change the output format (animated/lossless WebP becomes a flat raster).
 *    See {@link stripImageMetadataViaCanvas}.
 *
 * All container parsers are pure and run on the raw bytes; only the canvas
 * fallback touches the DOM.
 */

const JPEG_SOI = 0xffd8
const JPEG_EOI = 0xffd9

// Markers whose payload is metadata we want to remove from JPEGs.
//  - 0xFFE1 APP1  : EXIF and XMP
//  - 0xFFED APP13 : Photoshop IRB / IPTC
//  - 0xFFFE COM   : free-form comment
const JPEG_METADATA_MARKERS = new Set([0xffe1, 0xffed, 0xfffe])

// Standalone markers (no length field): RSTn (0xFFD0-0xFFD7) and the SOI/EOI/TEM.
const isStandaloneMarker = (marker: number): boolean => {
  return (marker >= 0xffd0 && marker <= 0xffd7) || marker === 0xffd8 || marker === 0xffd9 || marker === 0xff01
}

/**
 * Losslessly remove metadata segments (EXIF/XMP/IPTC/comments) from a JPEG byte
 * stream. Returns a new Uint8Array, or `null` if the bytes are not a valid JPEG
 * (caller should then fall back to the original or canvas re-encode).
 *
 * The pixel/scan data is copied verbatim; only the targeted APPn/COM segments
 * are excised, so the result decodes to identical pixels.
 */
export const stripJpegMetadata = (bytes: Uint8Array): Uint8Array | null => {
  // Must start with the SOI marker (0xFFD8).
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null
  }

  const out: number[] = []
  // Emit SOI.
  out.push(0xff, 0xd8)

  let offset = 2

  while (offset < bytes.length) {
    // Each marker starts with 0xFF (possibly preceded by fill 0xFF bytes).
    if (bytes[offset] !== 0xff) {
      // Not at a marker boundary -> malformed; bail out as "not strippable".
      return null
    }

    // Skip any fill bytes (0xFF 0xFF ...).
    let markerByteOffset = offset
    while (markerByteOffset < bytes.length && bytes[markerByteOffset] === 0xff) {
      markerByteOffset++
    }
    if (markerByteOffset >= bytes.length) {
      return null
    }

    const markerCode = bytes[markerByteOffset]
    const marker = 0xff00 | markerCode
    const afterMarker = markerByteOffset + 1

    if (marker === JPEG_EOI) {
      out.push(0xff, 0xd9)
      // Anything trailing after EOI is not part of the image; drop it.
      break
    }

    if (marker === JPEG_SOI || isStandaloneMarker(marker)) {
      // Standalone marker with no payload.
      out.push(0xff, markerCode)
      offset = afterMarker
      continue
    }

    // Marker with a 2-byte big-endian length (length includes the 2 length bytes).
    if (afterMarker + 1 >= bytes.length) {
      return null
    }
    const segmentLength = (bytes[afterMarker] << 8) | bytes[afterMarker + 1]
    if (segmentLength < 2) {
      return null
    }
    const segmentEnd = afterMarker + segmentLength

    if (marker === 0xffda) {
      // Start of Scan: the compressed image data follows the SOS header and runs
      // (with the entropy-coded stream) all the way to EOI. Copy the SOS marker,
      // its header, and everything after it verbatim so we don't disturb the
      // scan data (which can legally contain 0xFF 0xD0-0xD7 restart markers).
      for (let i = markerByteOffset - 1; i < bytes.length; i++) {
        out.push(bytes[i])
      }
      return Uint8Array.from(out)
    }

    if (segmentEnd > bytes.length) {
      return null
    }

    if (JPEG_METADATA_MARKERS.has(marker)) {
      // Drop this segment entirely (marker + length + payload).
      offset = segmentEnd
      continue
    }

    // Keep this segment verbatim (marker + length + payload).
    for (let i = markerByteOffset - 1; i < segmentEnd; i++) {
      out.push(bytes[i])
    }
    offset = segmentEnd
  }

  return Uint8Array.from(out)
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// Ancillary PNG chunks that carry metadata we want to drop. Critical chunks
// (IHDR, PLTE, IDAT, IEND) and rendering-relevant ancillary chunks (gAMA, cHRM,
// sRGB, iCCP, tRNS, bKGD, pHYs, etc.) are preserved.
const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])

const readChunkType = (bytes: Uint8Array, offset: number): string => {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

/**
 * Losslessly remove ancillary metadata chunks (tEXt/zTXt/iTXt/eXIf/tIME) from a
 * PNG byte stream. Returns a new Uint8Array, or `null` if the bytes are not a
 * valid PNG.
 */
export const stripPngMetadata = (bytes: Uint8Array): Uint8Array | null => {
  if (bytes.length < 8) {
    return null
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return null
    }
  }

  const out: number[] = []
  for (let i = 0; i < 8; i++) {
    out.push(bytes[i])
  }

  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
    const type = readChunkType(bytes, offset + 4)
    // Full chunk = 4 (length) + 4 (type) + length (data) + 4 (CRC).
    const chunkEnd = offset + 12 + length
    if (length < 0 || chunkEnd > bytes.length) {
      return null
    }

    if (!PNG_METADATA_CHUNKS.has(type)) {
      for (let i = offset; i < chunkEnd; i++) {
        out.push(bytes[i])
      }
    }

    offset = chunkEnd

    if (type === 'IEND') {
      break
    }
  }

  return Uint8Array.from(out)
}

/**
 * Lossy fallback: decode the image and re-encode it through a canvas, which
 * drops ALL metadata (the canvas only carries pixels). Used for formats we have
 * no lossless container rewriter for (e.g. WebP).
 *
 * Tradeoffs:
 *  - For already-compressed formats this re-compresses the pixels and is LOSSY.
 *  - We try to re-encode to the SAME mime type; if the browser can't encode it
 *    (canvas.toBlob returns null), we fall back to PNG (lossless raster) so the
 *    upload still succeeds, at the cost of a larger file and a format change.
 *  - Animated images collapse to their first frame.
 */
export const stripImageMetadataViaCanvas = async (file: File): Promise<File> => {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await loadImage(objectUrl)

    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth || image.width
    canvas.height = image.naturalHeight || image.height

    if (canvas.width === 0 || canvas.height === 0) {
      return file
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return file
    }
    ctx.drawImage(image, 0, 0)

    const targetType = canEncodeToType(file.type) ? file.type : 'image/png'
    const blob = await canvasToBlob(canvas, targetType)
    if (!blob) {
      return file
    }

    const name = targetType === file.type ? file.name : replaceExtensionForPng(file.name)
    return new File([blob], name, { type: blob.type || targetType, lastModified: file.lastModified })
  } catch {
    // If decode/re-encode fails for any reason, upload the original rather than
    // breaking the upload entirely.
    return file
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

const loadImage = (src: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to decode image for metadata stripping'))
    image.src = src
  })
}

const canvasToBlob = (canvas: HTMLCanvasElement, type: string): Promise<Blob | null> => {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type)
  })
}

// Formats canvas.toBlob is reasonably expected to encode.
const canEncodeToType = (type: string): boolean => {
  return type === 'image/jpeg' || type === 'image/png' || type === 'image/webp'
}

const replaceExtensionForPng = (name: string): string => {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    return `${name}.png`
  }
  return `${name.slice(0, dot)}.png`
}

/**
 * Strip metadata from an image File, preferring a lossless container rewrite and
 * falling back to a lossy canvas re-encode. Returns a NEW File when stripping
 * occurred, or the ORIGINAL file when:
 *  - the file is not an image, or
 *  - the lossless rewrite produced no smaller/different output and the format has
 *    no metadata to remove, or
 *  - all strategies fail.
 *
 * Never throws; on any error the original file is returned so uploads still work.
 */
export const stripImageMetadata = async (file: File): Promise<File> => {
  if (!file.type.startsWith('image/')) {
    return file
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())

    if (file.type === 'image/jpeg' || file.type === 'image/jpg') {
      const stripped = stripJpegMetadata(bytes)
      if (stripped && stripped.length < bytes.length) {
        return new File([stripped as BlobPart], file.name, { type: file.type, lastModified: file.lastModified })
      }
      // No metadata segments found (already clean) -> keep original bytes.
      if (stripped) {
        return file
      }
    }

    if (file.type === 'image/png') {
      const stripped = stripPngMetadata(bytes)
      if (stripped && stripped.length < bytes.length) {
        return new File([stripped as BlobPart], file.name, { type: file.type, lastModified: file.lastModified })
      }
      if (stripped) {
        return file
      }
    }

    // WebP and anything else: lossy canvas re-encode.
    return await stripImageMetadataViaCanvas(file)
  } catch {
    return file
  }
}
