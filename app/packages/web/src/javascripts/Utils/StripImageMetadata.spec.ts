import { stripJpegMetadata, stripPngMetadata } from './StripImageMetadata'

/**
 * Build a minimal but structurally-valid JPEG byte stream:
 *   SOI, APP0(JFIF), APP1(EXIF), DQT, SOF0, DHT, SOS + scan data, EOI
 * The scan data intentionally contains a 0xFF 0xD0 restart-marker-like byte
 * sequence to prove we don't accidentally parse into the entropy-coded stream.
 */
const buildSyntheticJpeg = (): Uint8Array => {
  const bytes: number[] = []

  const pushSegment = (marker: number, payload: number[]) => {
    bytes.push(0xff, marker & 0xff)
    const length = payload.length + 2
    bytes.push((length >> 8) & 0xff, length & 0xff)
    bytes.push(...payload)
  }

  // SOI
  bytes.push(0xff, 0xd8)

  // APP0 (JFIF) - kept
  pushSegment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])

  // APP1 (EXIF) - MUST be removed. Marker "Exif\0\0" then dummy TIFF/GPS bytes.
  pushSegment(
    0xe1,
    [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, /* fake exif body incl fake GPS */ 0x4d, 0x4d, 0x00, 0x2a, 0x12, 0x34, 0x56, 0x78],
  )

  // DQT - kept
  pushSegment(0xdb, [0x00, ...new Array(64).fill(0x10)])

  // SOF0 - kept
  pushSegment(0xc0, [0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00])

  // DHT - kept (minimal)
  pushSegment(0xc4, [0x00, ...new Array(16).fill(0x00), 0x00])

  // SOS marker + header, then scan data ending at EOI.
  bytes.push(0xff, 0xda)
  const sosHeader = [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]
  bytes.push(((sosHeader.length + 2) >> 8) & 0xff, (sosHeader.length + 2) & 0xff)
  bytes.push(...sosHeader)
  // Entropy-coded scan data containing 0xFF00 (stuffed) and 0xFFD0 (restart).
  bytes.push(0xaa, 0xff, 0x00, 0xbb, 0xff, 0xd0, 0xcc)

  // EOI
  bytes.push(0xff, 0xd9)

  return Uint8Array.from(bytes)
}

const findMarker = (bytes: Uint8Array, marker: number): number => {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === marker) {
      return i
    }
  }
  return -1
}

describe('stripJpegMetadata', () => {
  it('removes the APP1/EXIF segment while keeping SOI and EOI markers', () => {
    const input = buildSyntheticJpeg()

    // Sanity: the input actually contains an APP1 segment.
    expect(findMarker(input, 0xe1)).toBeGreaterThanOrEqual(0)

    const output = stripJpegMetadata(input)
    expect(output).not.toBeNull()
    const result = output as Uint8Array

    // APP1 (EXIF) marker is gone.
    expect(findMarker(result, 0xe1)).toBe(-1)

    // The "Exif" identifier bytes are gone.
    const exifSignature = [0x45, 0x78, 0x69, 0x66]
    let foundExif = false
    for (let i = 0; i + 3 < result.length; i++) {
      if (
        result[i] === exifSignature[0] &&
        result[i + 1] === exifSignature[1] &&
        result[i + 2] === exifSignature[2] &&
        result[i + 3] === exifSignature[3]
      ) {
        foundExif = true
        break
      }
    }
    expect(foundExif).toBe(false)

    // SOI at start, EOI at end intact.
    expect(result[0]).toBe(0xff)
    expect(result[1]).toBe(0xd8)
    expect(result[result.length - 2]).toBe(0xff)
    expect(result[result.length - 1]).toBe(0xd9)

    // Output is smaller than input (we removed a segment).
    expect(result.length).toBeLessThan(input.length)

    // Non-metadata segments are preserved (APP0/JFIF, DQT, SOF0, SOS still present).
    expect(findMarker(result, 0xe0)).toBeGreaterThanOrEqual(0) // APP0
    expect(findMarker(result, 0xdb)).toBeGreaterThanOrEqual(0) // DQT
    expect(findMarker(result, 0xc0)).toBeGreaterThanOrEqual(0) // SOF0
    expect(findMarker(result, 0xda)).toBeGreaterThanOrEqual(0) // SOS
  })

  it('preserves the entropy-coded scan data verbatim (incl. 0xFF00 / restart bytes)', () => {
    const input = buildSyntheticJpeg()
    const result = stripJpegMetadata(input) as Uint8Array

    // The scan data tail "...0xAA 0xFF 0x00 0xBB 0xFF 0xD0 0xCC 0xFF 0xD9" must
    // appear intact at the very end.
    const tail = [0xaa, 0xff, 0x00, 0xbb, 0xff, 0xd0, 0xcc, 0xff, 0xd9]
    const start = result.length - tail.length
    expect(start).toBeGreaterThan(0)
    expect(Array.from(result.slice(start))).toEqual(tail)
  })

  it('returns the bytes unchanged in structure when there is no metadata to remove', () => {
    // SOI + SOF/SOS-less minimal: just SOI, a kept APP0, SOS+scan, EOI.
    const bytes: number[] = [0xff, 0xd8]
    // APP0
    bytes.push(0xff, 0xe0, 0x00, 0x04, 0x11, 0x22)
    // SOS
    bytes.push(0xff, 0xda, 0x00, 0x03, 0x00, 0x99, 0xff, 0xd9)
    const input = Uint8Array.from(bytes)

    const result = stripJpegMetadata(input) as Uint8Array
    expect(result).not.toBeNull()
    // No APP1 existed, so output equals input.
    expect(Array.from(result)).toEqual(Array.from(input))
  })

  it('returns null for non-JPEG bytes', () => {
    expect(stripJpegMetadata(Uint8Array.from([0x00, 0x01, 0x02]))).toBeNull()
    expect(stripJpegMetadata(Uint8Array.from([]))).toBeNull()
  })
})

describe('stripPngMetadata', () => {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

  const buildChunk = (type: string, data: number[]): number[] => {
    const len = data.length
    const typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]
    // CRC is not validated by the stripper, so use a placeholder.
    return [(len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...typeBytes, ...data, 0, 0, 0, 0]
  }

  it('removes tEXt/eXIf metadata chunks but keeps IHDR/IDAT/IEND', () => {
    const bytes: number[] = [...PNG_SIG]
    bytes.push(...buildChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]))
    bytes.push(...buildChunk('tEXt', [0x41, 0x42, 0x00, 0x43])) // metadata - removed
    bytes.push(...buildChunk('eXIf', [0x4d, 0x4d, 0x00, 0x2a])) // metadata - removed
    bytes.push(...buildChunk('IDAT', [0x78, 0x9c, 0x00]))
    bytes.push(...buildChunk('IEND', []))
    const input = Uint8Array.from(bytes)

    const output = stripPngMetadata(input)
    expect(output).not.toBeNull()
    const result = output as Uint8Array

    const typeAt = (b: Uint8Array, type: string): boolean => {
      for (let i = 0; i + 3 < b.length; i++) {
        if (
          b[i] === type.charCodeAt(0) &&
          b[i + 1] === type.charCodeAt(1) &&
          b[i + 2] === type.charCodeAt(2) &&
          b[i + 3] === type.charCodeAt(3)
        ) {
          return true
        }
      }
      return false
    }

    expect(typeAt(result, 'tEXt')).toBe(false)
    expect(typeAt(result, 'eXIf')).toBe(false)
    expect(typeAt(result, 'IHDR')).toBe(true)
    expect(typeAt(result, 'IDAT')).toBe(true)
    expect(typeAt(result, 'IEND')).toBe(true)
    expect(result.length).toBeLessThan(input.length)
    // Signature preserved.
    expect(Array.from(result.slice(0, 8))).toEqual(PNG_SIG)
  })

  it('returns null for non-PNG bytes', () => {
    expect(stripPngMetadata(Uint8Array.from([0xff, 0xd8, 0xff]))).toBeNull()
  })
})
