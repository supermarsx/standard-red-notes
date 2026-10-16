import type { ChatMessage, AssistantImageAttachment } from './providers/types'

export function profileSupportsImageInputs(profile: { supportsImageInputs?: boolean }, provider: string): boolean {
  return profile.supportsImageInputs === true && (provider === 'openai' || provider === 'openai-compatible')
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (
    bytes.length < 4 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes[bytes.length - 2] !== 255 ||
    bytes[bytes.length - 1] !== 217
  ) {
    return undefined
  }
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 255) {
      return undefined
    }
    while (bytes[offset] === 255) {
      offset++
    }
    const marker = bytes[offset++]
    if (marker === 0xda || marker === 0xd9) {
      return undefined
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue
    }
    if (offset + 2 > bytes.length) {
      return undefined
    }
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) {
      return undefined
    }
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) {
        return undefined
      }
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  return undefined
}

/** No remote URLs, redirects, caller-selected capabilities, or unbounded base64. */
export function validateAssistantImages(messages: ChatMessage[], supported: boolean, request: unknown): void {
  if (!Array.isArray(messages)) {
    throw new Error('Assistant messages must be an array.')
  }
  let count = 0
  for (const message of messages) {
    if (!message || typeof message !== 'object' || message.images === undefined) {
      continue
    }
    if (!supported) {
      throw new Error('Image input is not enabled for this assistant profile and provider.')
    }
    if (message.role !== 'user' || !Array.isArray(message.images) || message.images.length > 3) {
      throw new Error('Invalid assistant image input.')
    }
    const normalized: AssistantImageAttachment[] = []
    for (const raw of message.images) {
      if (
        !raw ||
        typeof raw !== 'object' ||
        raw.kind !== 'image' ||
        typeof raw.name !== 'string' ||
        !raw.name ||
        raw.name.length > 128 ||
        /[\x00-\x1f/\\]/.test(raw.name) ||
        typeof raw.dataUrl !== 'string' ||
        raw.dataUrl.length > 87407 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(raw.dataUrl)
      ) {
        throw new Error('Invalid assistant image input.')
      }
      const encoded = raw.dataUrl.slice(23)
      const bytes = Buffer.from(encoded, 'base64')
      const dimensions = jpegDimensions(bytes)
      if (
        bytes.length > 65536 ||
        bytes.toString('base64') !== encoded ||
        !dimensions ||
        !Number.isSafeInteger(raw.width) ||
        !Number.isSafeInteger(raw.height) ||
        raw.width < 1 ||
        raw.height < 1 ||
        raw.width > 1280 ||
        raw.height > 1280 ||
        raw.width !== dimensions.width ||
        raw.height !== dimensions.height
      ) {
        throw new Error('Invalid assistant image input.')
      }
      normalized.push({ kind: 'image', name: raw.name, dataUrl: raw.dataUrl, width: raw.width, height: raw.height })
      count++
    }
    message.images = normalized
  }
  if (count && Buffer.byteLength(JSON.stringify(request), 'utf8') > 384 * 1024) {
    throw new Error('Assistant attachments exceed the request size limit. Reduce context or start a new chat.')
  }
}
