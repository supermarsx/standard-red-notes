import assert from 'node:assert/strict'
import test from 'node:test'
import { inflateSync } from 'node:zlib'

import {
  blend,
  chunk,
  crc32,
  downsample,
  drawPixel,
  drawRect,
  icoEncode,
  inRoundedRect,
  pngEncode,
  renderIcon,
} from './generate-brand-assets.mjs'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function readChunks(png) {
  const chunks = []
  let offset = PNG_SIGNATURE.length
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    const crc = png.readUInt32BE(offset + 8 + length)
    chunks.push({ type, data, crc })
    offset += 12 + length
  }
  return chunks
}

test('crc32 matches the standard CRC-32 check value', () => {
  // The canonical CRC-32 check vector: "123456789" -> 0xCBF43926.
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926)
  assert.equal(crc32(Buffer.alloc(0)), 0)
  assert.equal(crc32(Buffer.from([0x00])), 0xd202ef8d)
})

test('crc32 normalises a high-bit result to an unsigned 32-bit integer', () => {
  // Without the final `>>> 0` this input yields -1 and every CRC written into a
  // PNG/ICO header would be wrong.
  const value = crc32(Buffer.from([0xff, 0xff, 0xff, 0xff]))
  assert.equal(value, 0xffffffff)
  assert.ok(value > 0, `crc32 must be unsigned, got ${value}`)
})

test('chunk lays out length, type, payload and a CRC over type+payload', () => {
  const payload = Buffer.from([1, 2, 3])
  const encoded = chunk('IDAT', payload)

  assert.equal(encoded.length, 12 + payload.length)
  assert.equal(encoded.readUInt32BE(0), payload.length)
  assert.equal(encoded.toString('ascii', 4, 8), 'IDAT')
  assert.deepEqual([...encoded.subarray(8, 11)], [1, 2, 3])
  assert.equal(encoded.readUInt32BE(11), crc32(Buffer.concat([Buffer.from('IDAT', 'ascii'), payload])))
})

test('chunk handles a zero-length payload such as IEND', () => {
  const encoded = chunk('IEND', Buffer.alloc(0))
  assert.equal(encoded.length, 12)
  assert.equal(encoded.readUInt32BE(0), 0)
  assert.equal(encoded.readUInt32BE(8), crc32(Buffer.from('IEND', 'ascii')))
})

test('pngEncode writes a signature, a truecolour-alpha IHDR and an IEND', () => {
  const width = 2
  const height = 3
  const png = pngEncode(width, height, Buffer.alloc(width * height * 4, 7))

  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE)

  const chunks = readChunks(png)
  assert.deepEqual(chunks.map((entry) => entry.type), ['IHDR', 'IDAT', 'IEND'])

  const ihdr = chunks[0].data
  assert.equal(ihdr.length, 13)
  assert.equal(ihdr.readUInt32BE(0), width)
  assert.equal(ihdr.readUInt32BE(4), height)
  assert.equal(ihdr[8], 8, 'bit depth must be 8')
  assert.equal(ihdr[9], 6, 'colour type must be 6 (RGBA)')
  assert.deepEqual([ihdr[10], ihdr[11], ihdr[12]], [0, 0, 0], 'compression/filter/interlace must be 0')
})

test('pngEncode round-trips pixel data with a zero filter byte per scanline', () => {
  const width = 2
  const height = 2
  const rgba = Buffer.from([
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16,
  ])
  const png = pngEncode(width, height, rgba)
  const idat = readChunks(png).find((entry) => entry.type === 'IDAT')
  const scanlines = inflateSync(idat.data)

  assert.equal(scanlines.length, (width * 4 + 1) * height)
  assert.equal(scanlines[0], 0, 'row 0 filter byte')
  assert.deepEqual([...scanlines.subarray(1, 9)], [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(scanlines[9], 0, 'row 1 filter byte')
  assert.deepEqual([...scanlines.subarray(10, 18)], [9, 10, 11, 12, 13, 14, 15, 16])
})

test('pngEncode chunk CRCs are self-consistent', () => {
  const png = pngEncode(4, 4, Buffer.alloc(4 * 4 * 4, 0x40))
  for (const entry of readChunks(png)) {
    assert.equal(
      entry.crc,
      crc32(Buffer.concat([Buffer.from(entry.type, 'ascii'), entry.data])),
      `CRC mismatch for ${entry.type}`,
    )
  }
})

test('blend leaves the base untouched at zero alpha and replaces it at full alpha', () => {
  const base = [10, 20, 30, 255]
  assert.deepEqual(blend(base, [200, 100, 50, 255], 0), [10, 20, 30, 255])
  assert.deepEqual(blend(base, [200, 100, 50, 255], 1), [200, 100, 50, 255])
})

test('blend mixes colour and alpha proportionally', () => {
  assert.deepEqual(blend([0, 0, 0, 0], [255, 255, 255, 255], 0.5), [128, 128, 128, 128])
  // A half-transparent colour at full alpha over an opaque base stays opaque.
  assert.deepEqual(blend([0, 0, 0, 255], [255, 255, 255, 128], 1), [128, 128, 128, 255])
})

test('drawPixel composites into the buffer and ignores out-of-bounds writes', () => {
  const width = 2
  const buffer = Buffer.alloc(width * width * 4, 0)

  drawPixel(buffer, width, 1, 1, [255, 0, 0, 255])
  assert.deepEqual([...buffer.subarray(12, 16)], [255, 0, 0, 255])

  const before = Buffer.from(buffer)
  for (const [x, y] of [[-1, 0], [0, -1], [2, 0], [0, 2]]) {
    drawPixel(buffer, width, x, y, [0, 255, 0, 255])
  }
  assert.deepEqual(buffer, before, 'out-of-bounds draws must not mutate the buffer')
})

test('inRoundedRect excludes the clipped corners and includes the body', () => {
  const rect = [0, 0, 10, 10, 4]
  assert.equal(inRoundedRect(5, 5, ...rect), true, 'centre')
  assert.equal(inRoundedRect(5, 0.5, ...rect), true, 'top edge midpoint')
  assert.equal(inRoundedRect(0.2, 0.2, ...rect), false, 'top-left corner is rounded away')
  assert.equal(inRoundedRect(9.8, 9.8, ...rect), false, 'bottom-right corner is rounded away')
})

test('drawRect fills a half-open region', () => {
  const width = 4
  const buffer = Buffer.alloc(width * width * 4, 0)
  drawRect(buffer, width, 1, 1, 3, 3, [1, 2, 3, 255])

  const filled = []
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (buffer[(y * width + x) * 4 + 3] !== 0) filled.push(`${x},${y}`)
    }
  }
  assert.deepEqual(filled, ['1,1', '2,1', '1,2', '2,2'])
})

test('downsample averages each supersampled block', () => {
  // 2x2 output from a 4x4 source: each output pixel is the mean of its 2x2 block.
  const highSize = 4
  const high = Buffer.alloc(highSize * highSize * 4)
  for (let y = 0; y < highSize; y += 1) {
    for (let x = 0; x < highSize; x += 1) {
      const offset = (y * highSize + x) * 4
      // Top-left block: 0,10,20,30 -> mean 15. Everything else: 100.
      const value = x < 2 && y < 2 ? (y * 2 + x) * 10 : 100
      high[offset] = value
      high[offset + 1] = value
      high[offset + 2] = value
      high[offset + 3] = 255
    }
  }

  const out = downsample(high, highSize, 2, 2)
  assert.equal(out.length, 2 * 2 * 4)
  assert.equal(out[0], 15, 'top-left mean of 0,10,20,30')
  assert.equal(out[3], 255, 'alpha preserved')
  assert.equal(out[4], 100, 'top-right block')
  assert.equal(out[8], 100, 'bottom-left block')
  assert.equal(out[12], 100, 'bottom-right block')
})

test('icoEncode writes a valid ICO directory with cumulative image offsets', () => {
  const images = [
    { size: 16, data: Buffer.alloc(30, 1) },
    { size: 32, data: Buffer.alloc(40, 2) },
    { size: 256, data: Buffer.alloc(50, 3) },
  ]
  const ico = icoEncode(images)

  assert.equal(ico.readUInt16LE(0), 0, 'reserved')
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 = icon')
  assert.equal(ico.readUInt16LE(4), images.length)

  let expectedOffset = 6 + images.length * 16
  images.forEach((image, index) => {
    const entry = 6 + index * 16
    const encodedSize = image.size >= 256 ? 0 : image.size
    assert.equal(ico[entry], encodedSize, `width byte for ${image.size}`)
    assert.equal(ico[entry + 1], encodedSize, `height byte for ${image.size}`)
    assert.equal(ico.readUInt16LE(entry + 4), 1, 'colour planes')
    assert.equal(ico.readUInt16LE(entry + 6), 32, 'bits per pixel')
    assert.equal(ico.readUInt32LE(entry + 8), image.data.length, 'payload size')
    assert.equal(ico.readUInt32LE(entry + 12), expectedOffset, 'payload offset')
    assert.deepEqual(
      ico.subarray(expectedOffset, expectedOffset + image.data.length),
      image.data,
      'payload bytes',
    )
    expectedOffset += image.data.length
  })

  assert.equal(ico.length, expectedOffset, 'no trailing bytes')
})

test('renderIcon produces a decodable PNG at the requested size', () => {
  const size = 16
  const png = renderIcon(size)

  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE)
  const ihdr = readChunks(png)[0]
  assert.equal(ihdr.type, 'IHDR')
  assert.equal(ihdr.data.readUInt32BE(0), size)
  assert.equal(ihdr.data.readUInt32BE(4), size)

  const idat = readChunks(png).find((entry) => entry.type === 'IDAT')
  assert.equal(inflateSync(idat.data).length, (size * 4 + 1) * size)
})

test('renderIcon paints the brand red card, not an empty transparent canvas', () => {
  const size = 32
  const png = renderIcon(size)
  const idat = readChunks(png).find((entry) => entry.type === 'IDAT')
  const scanlines = inflateSync(idat.data)

  const pixelAt = (x, y) => {
    const offset = y * (size * 4 + 1) + 1 + x * 4
    return [...scanlines.subarray(offset, offset + 4)]
  }

  // The very corner is outside the rounded card, so it stays transparent.
  assert.equal(pixelAt(0, 0)[3], 0, 'corner must be transparent')

  // Just inside the card edge the fill is the brand red (#be1f2d), opaque.
  const [r, g, b, a] = pixelAt(size / 2, 4)
  assert.equal(a, 255, 'card body must be opaque')
  assert.ok(r > 150 && g < 90 && b < 90, `expected a red card body, got rgb(${r},${g},${b})`)

  // The note page in the middle is the paper colour, much lighter than the card.
  const centre = pixelAt(size / 2, Math.round(size * 0.35))
  assert.ok(
    centre[0] > 200 && centre[1] > 180 && centre[2] > 180,
    `expected a light paper page in the centre, got rgb(${centre.slice(0, 3).join(',')})`,
  )
})
