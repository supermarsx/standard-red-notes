import 'reflect-metadata'

import { OcrPageImage, OcrRecognizer, OcrService } from './OcrService'

describe('OcrService', () => {
  const options = { defaultLanguage: 'eng', maxImageBytes: 1000, maxPages: 3 }

  const makeService = (recognizer: OcrRecognizer) => new OcrService(recognizer, options)

  const page = (pageNumber: number, size = 10): OcrPageImage => ({
    pageNumber,
    image: Buffer.alloc(size, 1),
  })

  it('recognizes each page in order and trims the text', async () => {
    const recognizer: OcrRecognizer = jest.fn(async (_image, _lang) => '  hello world  ')
    const service = makeService(recognizer)

    const result = await service.recognizePages([page(1), page(2)])

    expect(result).toEqual([
      { pageNumber: 1, text: 'hello world' },
      { pageNumber: 2, text: 'hello world' },
    ])
    expect(recognizer).toHaveBeenCalledTimes(2)
  })

  it('passes the requested language through to the recognizer', async () => {
    const recognizer: OcrRecognizer = jest.fn(async () => 'x')
    await makeService(recognizer).recognizePages([page(1)], 'eng+deu')

    expect(recognizer).toHaveBeenCalledWith(expect.any(Buffer), 'eng+deu')
  })

  it('falls back to the default language for an absent or invalid language', async () => {
    const recognizer: OcrRecognizer = jest.fn(async () => 'x')
    const service = makeService(recognizer)

    await service.recognizePages([page(1)])
    expect(recognizer).toHaveBeenLastCalledWith(expect.any(Buffer), 'eng')

    await service.recognizePages([page(2)], 'not a lang!!')
    expect(recognizer).toHaveBeenLastCalledWith(expect.any(Buffer), 'eng')
  })

  it('returns an empty array for no pages without invoking the recognizer', async () => {
    const recognizer: OcrRecognizer = jest.fn(async () => 'x')
    const result = await makeService(recognizer).recognizePages([])

    expect(result).toEqual([])
    expect(recognizer).not.toHaveBeenCalled()
  })

  it('rejects more pages than the configured maximum', async () => {
    const recognizer: OcrRecognizer = jest.fn(async () => 'x')
    await expect(
      makeService(recognizer).recognizePages([page(1), page(2), page(3), page(4)]),
    ).rejects.toThrow(/too many pages/i)
    expect(recognizer).not.toHaveBeenCalled()
  })

  it('rejects an oversized page image before recognizing anything', async () => {
    const recognizer: OcrRecognizer = jest.fn(async () => 'x')
    await expect(makeService(recognizer).recognizePages([page(1, 2000)])).rejects.toThrow(/too large/i)
    expect(recognizer).not.toHaveBeenCalled()
  })

  it('rejects an empty page image', async () => {
    const recognizer: OcrRecognizer = jest.fn(async () => 'x')
    await expect(makeService(recognizer).recognizePages([page(1, 0)])).rejects.toThrow(/empty image/i)
    expect(recognizer).not.toHaveBeenCalled()
  })

  describe('resolveLanguage', () => {
    const service = makeService(jest.fn(async () => ''))

    it.each([
      ['eng', 'eng'],
      ['eng+deu', 'eng+deu'],
      ['chi_sim', 'chi_sim'],
      ['  fra  ', 'fra'],
    ])('accepts %s', (input, expected) => {
      expect(service.resolveLanguage(input)).toEqual(expected)
    })

    it.each([[undefined], [''], ['12'], ['en;rm -rf'], ['../etc/passwd']])(
      'falls back to default for invalid %s',
      (input) => {
        expect(service.resolveLanguage(input as string | undefined)).toEqual('eng')
      },
    )
  })
})
