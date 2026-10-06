/**
 * @jest-environment jsdom
 */
import { isRenderableSharedImageSource } from '@/Components/SuperEditor/Lexical/Nodes/SharedImageNode'

import {
  createApplicationShareAssetSource,
  encodeBase64,
  inlineShareAssets,
  shareAssetPlaceholderText,
  ShareAssetFile,
  ShareAssetSource,
  SHARE_ASSET_MAX_FILE_BYTES,
  SHARE_ASSET_MAX_TOTAL_BYTES,
} from './shareAssets'

/**
 * The tests that matter here are the ones proving what does NOT travel.
 *
 * A share link is public, read-only and short-lived. Inlining an image into the
 * envelope is only safe while the envelope contains the images that note embeds
 * AND NOTHING ELSE — not a neighbouring attachment in the same account, not a
 * file the account does not hold, not a non-image the reader never asked for,
 * and not bytes that merely claim to be an image. A suite that only proved the
 * happy path would be worthless: the whole risk lives in the refusals.
 */

const EMBEDDED = '11111111-1111-4111-8111-111111111111'
const NEIGHBOUR = '22222222-2222-4222-8222-222222222222'
const FOREIGN = '33333333-3333-4333-8333-333333333333'

/** A real, decodable 1x1 PNG. */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

/** A real PDF header — an image MIME lying about its content. */
const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xc7, 0xec, 0x8f, 0xa2])

const file = (overrides: Partial<ShareAssetFile> = {}): ShareAssetFile => ({
  uuid: EMBEDDED,
  name: 'embedded.png',
  mimeType: 'image/png',
  decryptedSize: PNG_BYTES.length,
  ...overrides,
})

const paragraph = (text: string) => ({
  children: [{ detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 }],
  direction: 'ltr',
  format: '',
  indent: 0,
  type: 'paragraph',
  version: 1,
})

const snfile = (fileUuid: string, extra: Record<string, unknown> = {}) => ({
  type: 'snfile',
  version: 1,
  format: '',
  fileUuid,
  zoomLevel: 100,
  float: 'none',
  ...extra,
})

const lexical = (children: unknown[]) =>
  JSON.stringify({ root: { children, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } })

type SourceSpy = ShareAssetSource & {
  lookedUp: string[]
  downloaded: string[]
}

const makeSource = (
  files: Record<string, ShareAssetFile>,
  bytesFor: (uuid: string) => Uint8Array | null = () => PNG_BYTES,
): SourceSpy => {
  const lookedUp: string[] = []
  const downloaded: string[] = []
  return {
    lookedUp,
    downloaded,
    findFile: (uuid) => {
      lookedUp.push(uuid)
      return files[uuid]
    },
    readFileBytes: async (f) => {
      downloaded.push(f.uuid)
      return bytesFor(f.uuid)
    },
  }
}

const nodesOf = (text: string): Record<string, unknown>[] =>
  (JSON.parse(text) as { root: { children: Record<string, unknown>[] } }).root.children

describe('inlineShareAssets', () => {
  describe('what travels', () => {
    it('replaces the note’s embedded image with a self-contained data URL', async () => {
      const source = makeSource({ [EMBEDDED]: file() })

      const result = await inlineShareAssets(
        lexical([paragraph('before'), snfile(EMBEDDED), paragraph('after')]),
        source,
      )

      expect(result.inlined).toBe(1)
      expect(result.omitted).toEqual([])
      expect(result.bytes).toBe(PNG_BYTES.length)

      const nodes = nodesOf(result.text)
      expect(nodes[1].type).toBe('shared-image')
      expect(nodes[1].mimeType).toBe('image/png')
      expect(nodes[1].fileName).toBe('embedded.png')
      expect(nodes[1].src).toBe(`data:image/png;base64,${encodeBase64(PNG_BYTES)}`)
    })

    it('keeps the surrounding note text intact', async () => {
      const source = makeSource({ [EMBEDDED]: file() })

      const result = await inlineShareAssets(
        lexical([paragraph('before'), snfile(EMBEDDED), paragraph('after')]),
        source,
      )

      expect(result.text).toContain('before')
      expect(result.text).toContain('after')
    })

    it('carries the image’s layout (width, caption, float) across', async () => {
      const source = makeSource({ [EMBEDDED]: file() })

      const result = await inlineShareAssets(
        lexical([snfile(EMBEDDED, { width: 320, caption: 'Figure 1', float: 'right' })]),
        source,
      )

      const node = nodesOf(result.text)[0]
      expect(node.width).toBe(320)
      expect(node.caption).toBe('Figure 1')
      expect(node.float).toBe('right')
    })

    it('emits only the two documented node shapes, and never an snfile', async () => {
      const source = makeSource({ [EMBEDDED]: file() })

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED), snfile(FOREIGN)]), source)

      const nodes = nodesOf(result.text)
      expect(nodes.map((node) => node.type)).toEqual(['shared-image', 'shared-image'])
      expect(result.text).not.toContain('snfile')
      expect(nodes[0].src).toMatch(/^data:image\/png;base64,/)
      expect(nodes[1].src).toBeUndefined()
      expect(nodes[1].reason).toBe('not-found')
    })

    it('finds an image nested inside another block, not just at the top level', async () => {
      const source = makeSource({ [EMBEDDED]: file() })
      const nested = {
        type: 'collapsible-container',
        version: 1,
        children: [{ type: 'collapsible-content', version: 1, children: [snfile(EMBEDDED)] }],
      }

      const result = await inlineShareAssets(lexical([nested]), source)

      expect(result.inlined).toBe(1)
      expect(result.text).toContain('shared-image')
    })

    it('downloads a repeated image once and charges the budget once', async () => {
      const source = makeSource({ [EMBEDDED]: file() })

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED), snfile(EMBEDDED)]), source)

      expect(source.downloaded).toEqual([EMBEDDED])
      expect(result.inlined).toBe(1)
      expect(result.bytes).toBe(PNG_BYTES.length)
      expect(nodesOf(result.text).every((node) => node.type === 'shared-image' && node.src !== undefined)).toBe(true)
    })

    it('stops publishing the file uuid, which the old envelope carried in the clear', async () => {
      const source = makeSource({ [EMBEDDED]: file() })

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED)]), source)

      expect(result.text).not.toContain(EMBEDDED)
    })
  })

  describe('what must NOT travel', () => {
    it('never looks at — let alone downloads — a file the note does not embed', async () => {
      const source = makeSource({ [EMBEDDED]: file(), [NEIGHBOUR]: file({ uuid: NEIGHBOUR, name: 'neighbour.png' }) })

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED)]), source)

      expect(source.lookedUp).toEqual([EMBEDDED])
      expect(source.downloaded).toEqual([EMBEDDED])
      expect(result.text).not.toContain(NEIGHBOUR)
      expect(result.text).not.toContain('neighbour.png')
    })

    it('leaves a named placeholder, and no bytes, for a file this account does not hold', async () => {
      // Another account's file is exactly this case: `findItem` only ever sees
      // the signed-in account's items, so a foreign uuid resolves to nothing.
      const source = makeSource({})

      const result = await inlineShareAssets(lexical([snfile(FOREIGN)]), source)

      expect(source.downloaded).toEqual([])
      expect(result.inlined).toBe(0)
      expect(result.bytes).toBe(0)
      expect(result.omitted).toEqual([{ fileUuid: FOREIGN, reason: 'not-found' }])
      const node = nodesOf(result.text)[0]
      expect(node.type).toBe('shared-image')
      expect(node.src).toBeUndefined()
      expect(node.reason).toBe('not-found')
      expect(node.message).toContain('no longer in the author’s account')
    })

    it('refuses a non-image attachment without downloading it', async () => {
      const source = makeSource({
        [EMBEDDED]: file({ name: 'contract.pdf', mimeType: 'application/pdf', decryptedSize: 100 }),
      })

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED)]), source)

      expect(source.downloaded).toEqual([])
      expect(result.omitted).toEqual([{ fileUuid: EMBEDDED, name: 'contract.pdf', reason: 'not-an-image' }])
      expect(result.text).not.toContain('data:')
      expect(nodesOf(result.text)[0].reason).toBe('not-an-image')
      expect(String(nodesOf(result.text)[0].message)).toContain('Share links carry embedded images only')
    })

    it('refuses an SVG, which is markup rather than an inert bitmap', async () => {
      const source = makeSource({
        [EMBEDDED]: file({ name: 'diagram.svg', mimeType: 'image/svg+xml', decryptedSize: 100 }),
      })

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED)]), source)

      expect(source.downloaded).toEqual([])
      expect(result.omitted[0].reason).toBe('not-an-image')
    })

    it('refuses a file one byte over the per-file cap, and does not decrypt it', async () => {
      const source = makeSource({ [EMBEDDED]: file({ decryptedSize: SHARE_ASSET_MAX_FILE_BYTES + 1 }) })

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED)]), source)

      expect(source.downloaded).toEqual([])
      expect(result.omitted[0].reason).toBe('too-large')
      expect(result.text).not.toContain('data:')
    })

    it('accepts a file exactly at the per-file cap', async () => {
      const big = new Uint8Array(SHARE_ASSET_MAX_FILE_BYTES)
      big.set(PNG_BYTES, 0)
      const source = makeSource({ [EMBEDDED]: file({ decryptedSize: SHARE_ASSET_MAX_FILE_BYTES }) }, () => big)

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED)]), source)

      expect(result.inlined).toBe(1)
      expect(result.bytes).toBe(SHARE_ASSET_MAX_FILE_BYTES)
    })

    it('stops at the whole-share budget and says which image was left out', async () => {
      const chunk = SHARE_ASSET_MAX_FILE_BYTES
      const bytes = new Uint8Array(chunk)
      bytes.set(PNG_BYTES, 0)
      const uuids = Array.from({ length: 5 }, (_, index) => `0000000${index}-0000-4000-8000-000000000000`)
      const files = Object.fromEntries(
        uuids.map((uuid, index) => [uuid, file({ uuid, name: `image-${index}.png`, decryptedSize: chunk })]),
      )
      const source = makeSource(files, () => bytes)

      const result = await inlineShareAssets(lexical(uuids.map((uuid) => snfile(uuid))), source)

      // 6 MiB budget / 2 MiB each = three images fit, the rest do not.
      expect(result.inlined).toBe(3)
      expect(result.bytes).toBe(SHARE_ASSET_MAX_TOTAL_BYTES)
      expect(result.bytes).toBeLessThanOrEqual(SHARE_ASSET_MAX_TOTAL_BYTES)
      expect(result.omitted.map((omission) => omission.reason)).toEqual(['budget-exhausted', 'budget-exhausted'])
      // The two that did not fit were never decrypted either.
      expect(source.downloaded).toHaveLength(3)
    })

    it('never emits a src the renderer will refuse', async () => {
      // THE contract between this module and the viewer. If the builder could
      // say "1 image travelled" while producing a src the node degrades to a
      // placeholder, the sharer would be lied to and the reader would be shown
      // a gap neither of them could explain. The builder uses the renderer's
      // own predicate, and this pins that it stays that way.
      const fixtures: { name: string; mimeType: string; bytes: Uint8Array }[] = [
        { name: 'ok.png', mimeType: 'image/png', bytes: PNG_BYTES },
        { name: 'lying.png', mimeType: 'image/png', bytes: PDF_BYTES },
        { name: 'empty.png', mimeType: 'image/png', bytes: new Uint8Array(0) },
        { name: 'short.png', mimeType: 'image/png', bytes: PNG_BYTES.subarray(0, 4) },
        { name: 'odd.png', mimeType: 'image/png;charset=binary', bytes: PNG_BYTES },
        { name: 'upper.PNG', mimeType: 'IMAGE/PNG', bytes: PNG_BYTES },
      ]

      for (const fixture of fixtures) {
        const uuid = `fixture-${fixture.name}`
        const source = makeSource(
          { [uuid]: file({ uuid, name: fixture.name, mimeType: fixture.mimeType, decryptedSize: 64 }) },
          () => fixture.bytes,
        )

        const result = await inlineShareAssets(lexical([snfile(uuid)]), source)
        const node = nodesOf(result.text)[0]

        if (node.src === undefined) {
          expect(result.inlined).toBe(0)
          continue
        }
        expect(
          isRenderableSharedImageSource(node.src as string, node.mimeType as string, node.fileName as string),
        ).toBe(true)
      }
    })

    it('refuses bytes that are not the image the metadata claims', async () => {
      const source = makeSource({ [EMBEDDED]: file({ decryptedSize: PDF_BYTES.length }) }, () => PDF_BYTES)

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED)]), source)

      expect(result.inlined).toBe(0)
      expect(result.omitted[0].reason).toBe('content-mismatch')
      expect(result.text).not.toContain('data:')
      expect(result.bytes).toBe(0)
    })

    it('treats a reader that over-delivers as a failure rather than a larger budget', async () => {
      const tooMany = new Uint8Array(SHARE_ASSET_MAX_FILE_BYTES + 1)
      tooMany.set(PNG_BYTES, 0)
      const source = makeSource({ [EMBEDDED]: file({ decryptedSize: 10 }) }, () => tooMany)

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED)]), source)

      expect(result.inlined).toBe(0)
      expect(result.bytes).toBe(0)
      expect(result.omitted[0].reason).toBe('too-large')
    })

    it('reports a failed download as a failure, not as an empty image', async () => {
      const source = makeSource({ [EMBEDDED]: file() }, () => null)

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED)]), source)

      expect(result.inlined).toBe(0)
      expect(result.omitted).toEqual([{ fileUuid: EMBEDDED, name: 'embedded.png', reason: 'download-failed' }])
      expect(result.text).not.toContain('data:')
    })

    it('survives a reader that throws', async () => {
      const source: ShareAssetSource = {
        findFile: () => file(),
        readFileBytes: async () => {
          throw new Error('network died')
        },
      }

      const result = await inlineShareAssets(lexical([snfile(EMBEDDED)]), source)

      expect(result.omitted[0].reason).toBe('download-failed')
    })

    it('places a placeholder for a file node carrying no uuid at all', async () => {
      const source = makeSource({})

      const result = await inlineShareAssets(lexical([snfile('')]), source)

      expect(source.lookedUp).toEqual([])
      expect(result.omitted).toEqual([{ fileUuid: '', reason: 'not-found' }])
    })
  })

  describe('notes with nothing to inline', () => {
    it('returns a markdown note byte-for-byte unchanged', async () => {
      const source = makeSource({ [EMBEDDED]: file() })
      const text = '# Heading\n\nSome *markdown*, not JSON.'

      const result = await inlineShareAssets(text, source)

      expect(result).toEqual({ text, inlined: 0, omitted: [], bytes: 0 })
      expect(source.lookedUp).toEqual([])
    })

    it('returns a Super note with no attachments byte-for-byte unchanged', async () => {
      const source = makeSource({ [EMBEDDED]: file() })
      const text = lexical([paragraph('just words')])

      const result = await inlineShareAssets(text, source)

      expect(result.text).toBe(text)
      expect(source.lookedUp).toEqual([])
    })

    it('returns JSON that is not a Lexical document unchanged', async () => {
      const source = makeSource({})
      const text = JSON.stringify({ notLexical: true })

      const result = await inlineShareAssets(text, source)

      expect(result.text).toBe(text)
    })
  })
})

describe('shareAssetPlaceholderText', () => {
  it('names the file so the reader knows what is missing', () => {
    expect(shareAssetPlaceholderText({ fileUuid: EMBEDDED, name: 'holiday.png', reason: 'too-large' }, 9_000_000)).toBe(
      '[“holiday.png” (8.58 MB) is too large to embed in a share link, so it is not included here.]',
    )
  })

  it('says something accurate even when the name is unknown', () => {
    const text = shareAssetPlaceholderText({ fileUuid: EMBEDDED, reason: 'not-found' })
    expect(text).toContain('An attachment')
    expect(text).not.toContain('undefined')
  })

  it('gives each reason its own sentence rather than one catch-all', () => {
    const reasons = [
      'not-found',
      'not-an-image',
      'too-large',
      'budget-exhausted',
      'content-mismatch',
      'download-failed',
    ] as const
    const sentences = reasons.map((reason) => shareAssetPlaceholderText({ fileUuid: EMBEDDED, name: 'x.png', reason }))
    expect(new Set(sentences).size).toBe(reasons.length)
    expect(sentences.every((sentence) => sentence.includes('x.png'))).toBe(true)
  })
})

describe('createApplicationShareAssetSource', () => {
  const appWith = (item: unknown, download: (onBytes: (bytes: Uint8Array) => Promise<void>) => Promise<unknown>) => ({
    items: { findItem: () => item },
    files: {
      downloadFile: (_f: ShareAssetFile, onBytes: (bytes: Uint8Array) => Promise<void>) => download(onBytes),
    },
  })

  it('joins the streamed chunks in order', async () => {
    const source = createApplicationShareAssetSource(
      appWith(file(), async (onBytes) => {
        await onBytes(PNG_BYTES.subarray(0, 8))
        await onBytes(PNG_BYTES.subarray(8))
        return undefined
      }),
    )

    const bytes = await source.readFileBytes(file(), SHARE_ASSET_MAX_FILE_BYTES)

    expect(bytes).toEqual(PNG_BYTES)
  })

  it('treats a ClientDisplayableError result as a failure even when bytes arrived', async () => {
    // `downloadFile` resolves with a truthy error object and `undefined` on
    // success. Reading that the other way round turns a failed download into a
    // partial image nobody can tell is partial.
    const source = createApplicationShareAssetSource(
      appWith(file(), async (onBytes) => {
        await onBytes(PNG_BYTES)
        return { text: 'download failed' }
      }),
    )

    expect(await source.readFileBytes(file(), SHARE_ASSET_MAX_FILE_BYTES)).toBeNull()
  })

  it('refuses a stream that exceeds the cap instead of truncating it to a broken image', async () => {
    const source = createApplicationShareAssetSource(
      appWith(file(), async (onBytes) => {
        await onBytes(new Uint8Array(32))
        await onBytes(new Uint8Array(32))
        return undefined
      }),
    )

    expect(await source.readFileBytes(file(), 40)).toBeNull()
  })

  it('reports an empty download as a failure rather than a zero-byte image', async () => {
    const source = createApplicationShareAssetSource(appWith(file(), async () => undefined))

    expect(await source.readFileBytes(file(), SHARE_ASSET_MAX_FILE_BYTES)).toBeNull()
  })

  it('ignores an item that is not a file', async () => {
    const source = createApplicationShareAssetSource(
      appWith({ uuid: EMBEDDED, title: 'a note' }, async () => undefined),
    )

    expect(source.findFile(EMBEDDED)).toBeUndefined()
  })

  it('ignores a missing item', async () => {
    const source = createApplicationShareAssetSource(appWith(undefined, async () => undefined))

    expect(source.findFile(EMBEDDED)).toBeUndefined()
  })
})

describe('encodeBase64', () => {
  it('round-trips a buffer larger than one chunk', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17)
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = index % 256
    }

    const decoded = Uint8Array.from(atob(encodeBase64(bytes)), (character) => character.charCodeAt(0))

    expect(decoded).toEqual(bytes)
  })
})
