import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, '$1')
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const FAVICON_DIR = join(ROOT, 'app', 'packages', 'web', 'src', 'favicon')

const BRAND = {
  red: [190, 31, 45, 255],
  redDark: [96, 18, 26, 255],
  redDeep: [56, 13, 18, 255],
  paper: [255, 250, 246, 255],
  paperMuted: [255, 232, 226, 255],
  line: [190, 31, 45, 255],
  shadow: [65, 12, 18, 70],
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  typeBuffer.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length)
  return out
}

export function pngEncode(width, height, rgba) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    scanlines[row] = 0
    rgba.copy(scanlines, row + 1, y * width * 4, (y + 1) * width * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function blend(base, color, alpha) {
  const a = (color[3] / 255) * alpha
  const inv = 1 - a
  return [
    Math.round(color[0] * a + base[0] * inv),
    Math.round(color[1] * a + base[1] * inv),
    Math.round(color[2] * a + base[2] * inv),
    Math.round(255 * (a + (base[3] / 255) * inv)),
  ]
}

export function drawPixel(buffer, width, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= width || y >= width) return
  const offset = (y * width + x) * 4
  const base = [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]]
  const next = blend(base, color, alpha)
  buffer[offset] = next[0]
  buffer[offset + 1] = next[1]
  buffer[offset + 2] = next[2]
  buffer[offset + 3] = next[3]
}

export function inRoundedRect(x, y, left, top, right, bottom, radius) {
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

export function drawRoundedRect(buffer, width, rect, color) {
  const [left, top, right, bottom, radius] = rect
  for (let y = Math.floor(top); y <= Math.ceil(bottom); y += 1) {
    for (let x = Math.floor(left); x <= Math.ceil(right); x += 1) {
      if (inRoundedRect(x + 0.5, y + 0.5, left, top, right, bottom, radius)) {
        drawPixel(buffer, width, x, y, color)
      }
    }
  }
}

export function drawRect(buffer, width, left, top, right, bottom, color) {
  for (let y = Math.floor(top); y < Math.ceil(bottom); y += 1) {
    for (let x = Math.floor(left); x < Math.ceil(right); x += 1) {
      drawPixel(buffer, width, x, y, color)
    }
  }
}

export function drawTriangle(buffer, width, points, color) {
  const [a, b, c] = points
  const minX = Math.floor(Math.min(a[0], b[0], c[0]))
  const maxX = Math.ceil(Math.max(a[0], b[0], c[0]))
  const minY = Math.floor(Math.min(a[1], b[1], c[1]))
  const maxY = Math.ceil(Math.max(a[1], b[1], c[1]))
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5
      const py = y + 0.5
      const w0 = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])
      const w1 = (c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0])
      const w2 = (a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0])
      if (area >= 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0) {
        drawPixel(buffer, width, x, y, color)
      }
    }
  }
}

export function downsample(high, highSize, size, scale) {
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sums = [0, 0, 0, 0]
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const offset = (((y * scale + sy) * highSize + (x * scale + sx)) * 4)
          sums[0] += high[offset]
          sums[1] += high[offset + 1]
          sums[2] += high[offset + 2]
          sums[3] += high[offset + 3]
        }
      }
      const count = scale * scale
      const outOffset = (y * size + x) * 4
      out[outOffset] = Math.round(sums[0] / count)
      out[outOffset + 1] = Math.round(sums[1] / count)
      out[outOffset + 2] = Math.round(sums[2] / count)
      out[outOffset + 3] = Math.round(sums[3] / count)
    }
  }
  return out
}

export function renderIcon(size) {
  const scale = 4
  const highSize = size * scale
  const b = Buffer.alloc(highSize * highSize * 4)
  const s = scale
  const unit = size * s

  drawRoundedRect(b, highSize, [2 * s, 2 * s, unit - 2 * s, unit - 2 * s, 12 * s], BRAND.redDeep)
  drawRoundedRect(b, highSize, [4 * s, 4 * s, unit - 4 * s, unit - 4 * s, 10 * s], BRAND.red)

  // Quiet diagonal highlight, not a gradient orb: it gives the icon depth without
  // changing the simple red-note identity.
  drawTriangle(b, highSize, [[4 * s, 4 * s], [unit - 4 * s, 4 * s], [4 * s, unit - 4 * s]], [230, 72, 76, 88])

  const shadowOffset = Math.max(1, Math.round(size * 0.035)) * s
  const pageLeft = Math.round(size * 0.27) * s
  const pageTop = Math.round(size * 0.19) * s
  const pageRight = Math.round(size * 0.74) * s
  const pageBottom = Math.round(size * 0.78) * s
  const pageRadius = Math.max(2, Math.round(size * 0.055)) * s

  drawRoundedRect(
    b,
    highSize,
    [pageLeft + shadowOffset, pageTop + shadowOffset, pageRight + shadowOffset, pageBottom + shadowOffset, pageRadius],
    BRAND.shadow,
  )
  drawRoundedRect(b, highSize, [pageLeft, pageTop, pageRight, pageBottom, pageRadius], BRAND.paper)

  const fold = Math.round(size * 0.15) * s
  drawTriangle(b, highSize, [[pageRight - fold, pageTop], [pageRight, pageTop], [pageRight, pageTop + fold]], BRAND.paperMuted)
  drawTriangle(b, highSize, [[pageRight - fold, pageTop], [pageRight, pageTop + fold], [pageRight - fold, pageTop + fold]], BRAND.redDark)

  const lineLeft = pageLeft + Math.round(size * 0.105) * s
  const lineRight = pageRight - Math.round(size * 0.105) * s
  const lineH = Math.max(1, Math.round(size * 0.027)) * s
  const ys = [0.43, 0.54, 0.65].map((v) => Math.round(size * v) * s)
  for (const y of ys) {
    drawRoundedRect(b, highSize, [lineLeft, y, lineRight, y + lineH, lineH / 2], BRAND.line)
  }

  return pngEncode(size, size, downsample(b, highSize, size, scale))
}

export function icoEncode(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + images.length * 16
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)])
}

export function generateBrandAssets() {
  mkdirSync(FAVICON_DIR, { recursive: true })

  const pngs = new Map()
  for (const size of [16, 32, 48, 150, 180, 192, 512]) {
    pngs.set(size, renderIcon(size))
  }

  writeFileSync(join(FAVICON_DIR, 'favicon-16x16.png'), pngs.get(16))
  writeFileSync(join(FAVICON_DIR, 'favicon-32x32.png'), pngs.get(32))
  writeFileSync(join(FAVICON_DIR, 'mstile-150x150.png'), pngs.get(150))
  writeFileSync(join(FAVICON_DIR, 'apple-touch-icon.png'), pngs.get(180))
  writeFileSync(join(FAVICON_DIR, 'android-chrome-192x192.png'), pngs.get(192))
  writeFileSync(join(FAVICON_DIR, 'android-chrome-512x512.png'), pngs.get(512))
  writeFileSync(
    join(FAVICON_DIR, 'favicon.ico'),
    icoEncode([
      { size: 16, data: pngs.get(16) },
      { size: 32, data: pngs.get(32) },
      { size: 48, data: pngs.get(48) },
    ]),
  )

  writeFileSync(
    join(FAVICON_DIR, 'safari-pinned-tab.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <path fill="#000" d="M56 34h400c12 0 22 10 22 22v400c0 12-10 22-22 22H56c-12 0-22-10-22-22V56c0-12 10-22 22-22Zm112 90c-10 0-18 8-18 18v244c0 10 8 18 18 18h176c10 0 18-8 18-18V190l-66-66H168Zm149 28 17 17h-17v-17ZM206 241h100v28H206v-28Zm0 62h100v28H206v-28Z"/>
</svg>
`,
  )

  writeFileSync(
    join(FAVICON_DIR, 'site.webmanifest'),
    JSON.stringify(
      {
        name: 'Standard Red Notes',
        short_name: 'Red Notes',
        description: 'A self-hosted-first encrypted note-taking app for private notes, documents, and files.',
        icons: [
          { src: 'android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
        theme_color: '#be1f2d',
        background_color: '#fffaf6',
        display: 'standalone',
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(FAVICON_DIR, 'browserconfig.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<browserconfig>
  <msapplication>
    <tile>
      <square150x150logo src="favicon/mstile-150x150.png"/>
      <TileColor>#be1f2d</TileColor>
    </tile>
  </msapplication>
</browserconfig>
`,
  )

  console.log(`Generated Standard Red Notes brand assets in ${FAVICON_DIR}`)
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  generateBrandAssets()
}
