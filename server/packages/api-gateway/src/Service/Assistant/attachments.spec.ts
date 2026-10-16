import { profileSupportsImageInputs, validateAssistantImages } from './attachments'
import type { ChatMessage } from './providers/types'
const image = {
  kind: 'image' as const,
  name: 'photo.jpg',
  width: 1,
  height: 1,
  dataUrl: `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 1, 0, 1, 1, 255, 217]).toString('base64')}`,
}
it('requires explicit image support on a tested native adapter', () => {
  expect(profileSupportsImageInputs({ supportsImageInputs: true }, 'openai')).toBe(true)
  expect(profileSupportsImageInputs({ supportsImageInputs: true }, 'anthropic')).toBe(false)
  expect(profileSupportsImageInputs({}, 'openai')).toBe(false)
  expect(() => validateAssistantImages([{ role: 'user', content: 'describe', images: [image] }], false, {})).toThrow(
    'not enabled',
  )
})
it('accepts bounded native JPEG user input and strips unrecognized properties', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'describe', images: [{ ...image }] }]
  expect(() => validateAssistantImages(messages, true, { messages })).not.toThrow()
  expect(messages[0].images).toEqual([image])
})
it.each([
  { role: 'assistant', content: 'x', images: [image] },
  { role: 'user', content: 'x', images: [{ ...image, width: 1281 }] },
  { role: 'user', content: 'x', images: [{ ...image, height: 2 }] },
  { role: 'user', content: 'x', images: [{ ...image, dataUrl: 'https://example.test/image.jpg' }] },
  { role: 'user', content: 'x', images: [image, image, image, image] },
])('rejects invalid image-bearing requests before dispatch', (message) => {
  expect(() => validateAssistantImages([message as ChatMessage], true, {})).toThrow('Invalid')
})
it('bounds the entire request including context and tools', () => {
  expect(() =>
    validateAssistantImages([{ role: 'user', content: 'x', images: [image] }], true, {
      context: 'x'.repeat(384 * 1024),
    }),
  ).toThrow('size limit')
})
