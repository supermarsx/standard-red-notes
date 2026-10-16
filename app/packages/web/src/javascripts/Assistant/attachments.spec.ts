import { TextEncoder, TextDecoder } from 'node:util'
import type { WebApplication } from '@/Application/WebApplication'
import { PrefKey } from '@standardnotes/snjs'
import {
  normalizeAssistantAttachments,
  attachmentUserText,
  declaredDirectImageSupport,
  prepareAssistantAttachment,
  assertAttachmentBudget,
} from './attachments'
import { sanitizeAssistantChatMessages } from './assistantChatHistory'
import { boundProviderHistory } from './providerHistory'

beforeAll(() => {
  Object.assign(globalThis, { TextEncoder, TextDecoder })
})
const image = {
  kind: 'image' as const,
  name: 'photo.jpg',
  dataUrl: 'data:image/jpeg;base64,/9j/wAAICAABAAEB/9k=',
  width: 1,
  height: 1,
}
it('rejects remote images, noncanonical base64 and oversized text; preserves closed fields', () => {
  expect(normalizeAssistantAttachments([image])).toEqual([image])
  expect(normalizeAssistantAttachments([{ ...image, dataUrl: 'https://example.test/photo.jpg' }])).toBeUndefined()
  expect(normalizeAssistantAttachments([{ ...image, dataUrl: 'data:image/jpeg;base64,/9j/2R==' }])).toBeUndefined()
  expect(normalizeAssistantAttachments([{ kind: 'text', name: 'a.txt', text: 'x'.repeat(32769) }])).toBeUndefined()
  expect(
    normalizeAssistantAttachments([{ kind: 'text', name: 'a.txt', text: 'hello', unexpected: 'dropped' }]),
  ).toEqual([{ kind: 'text', name: 'a.txt', text: 'hello' }])
})
it('retains image context in encrypted history and provider history without charging base64 as narrative text', () => {
  const retained = sanitizeAssistantChatMessages([{ kind: 'user', id: 'u', text: 'describe', attachments: [image] }])
  expect(retained[0].attachments).toEqual([image])
  expect(sanitizeAssistantChatMessages([{ kind: 'assistant', id: 'a', text: 'answer', attachments: [image] }])).toEqual(
    [],
  )
  const hugeImage = { ...image, dataUrl: `data:image/jpeg;base64,${'A'.repeat(80000)}` }
  expect(boundProviderHistory([{ role: 'user', content: 'describe', images: [hugeImage] }], 1000)[0].images).toEqual([
    hugeImage,
  ])
})
it('quotes file data independently from user instruction and fails closed on total attachment budget', () => {
  expect(
    attachmentUserText('research topic', [{ kind: 'text', name: 'private.txt', text: 'private excerpt' }]),
  ).toContain('untrusted reference data')
  expect(attachmentUserText('research topic', [image])).toBe('research topic')
  expect(() => assertAttachmentBudget([[{ kind: 'text', name: 'x', text: 'x'.repeat(300000) }]])).toThrow('new chat')
})
it('binds explicit direct capability to the effective endpoint and model without model heuristics', () => {
  const getPreference = jest.fn((key) =>
    key === PrefKey.AssistantImageInputCapability
      ? JSON.stringify({ baseURL: 'https://example.test/v1', model: 'vision' })
      : '',
  )
  const app = { getPreference } as unknown as WebApplication
  expect(declaredDirectImageSupport(app, 'https://example.test', 'vision')).toBe(true)
  expect(declaredDirectImageSupport(app, 'https://example.test', 'other')).toBe(false)
  expect(declaredDirectImageSupport(app, 'https://another.test', 'vision')).toBe(false)
})
it('decodes only strict UTF-8 files and rejects binary and unsupported documents', async () => {
  const file = (name: string, data: Uint8Array) =>
    ({ name, type: '', size: data.length, arrayBuffer: async () => data.buffer }) as File
  expect(await prepareAssistantAttachment(file('notes.md', new TextEncoder().encode('## hello')), false)).toEqual({
    kind: 'text',
    name: 'notes.md',
    text: '## hello',
  })
  await expect(prepareAssistantAttachment(file('bad.txt', new Uint8Array([255, 254])), false)).rejects.toThrow()
  await expect(prepareAssistantAttachment(file('bad.txt', new Uint8Array([0])), false)).rejects.toThrow('binary')
  await expect(prepareAssistantAttachment(file('report.pdf', new Uint8Array([65])), false)).rejects.toThrow('UTF-8')
  await expect(
    prepareAssistantAttachment({ name: 'photo.png', type: 'image/png', size: 10 } as File, false),
  ).rejects.toThrow('not been declared')
})
