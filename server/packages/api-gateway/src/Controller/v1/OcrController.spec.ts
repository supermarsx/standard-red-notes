import 'reflect-metadata'

import { Request, Response } from 'express'
import { SettingName } from '@standardnotes/domain-core'

import { OcrController } from './OcrController'
import { OcrService } from '../../Service/Ocr/OcrService'

describe('OcrController', () => {
  let ocrService: jest.Mocked<OcrService>
  let response: Response
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const makeController = (enabled: boolean) =>
    new OcrController(enabled, 'eng', ocrService as unknown as OcrService)

  const responseWith = (settings?: Record<string, unknown>): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))
    return {
      locals: { user: { uuid: '1-2-3' }, settings },
      json: jsonMock,
      status: statusMock,
    } as unknown as Response
  }

  beforeEach(() => {
    ocrService = { recognizePages: jest.fn() } as unknown as jest.Mocked<OcrService>
  })

  describe('config', () => {
    it('reports available only when env enabled AND user allowed', async () => {
      response = responseWith({ [SettingName.NAMES.OcrServerAllowed]: 'true' })
      await makeController(true).config({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ serverOcrEnabled: true, allowed: true, available: true }))
    })

    it('reports not available when the user is not allowed', async () => {
      response = responseWith({ [SettingName.NAMES.OcrServerAllowed]: 'false' })
      await makeController(true).config({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, available: false }))
    })

    it('reports not available when env disabled even if allowed', async () => {
      response = responseWith({ [SettingName.NAMES.OcrServerAllowed]: 'true' })
      await makeController(false).config({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ serverOcrEnabled: false, available: false }))
    })

    it('fails closed (not allowed) when settings are absent', async () => {
      response = responseWith(undefined)
      await makeController(true).config({} as Request, response)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, available: false }))
    })
  })

  describe('recognize', () => {
    const recognizeRequest = (): Request =>
      ({ body: { pages: [{ pageNumber: 1, imageBase64: Buffer.from('img').toString('base64') }] } }) as unknown as Request

    it('refuses when the env master switch is off', async () => {
      response = responseWith({ [SettingName.NAMES.OcrServerAllowed]: 'true' })
      await makeController(false).recognize(recognizeRequest(), response)
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(ocrService.recognizePages).not.toHaveBeenCalled()
    })

    it('refuses when the user is not allowed', async () => {
      response = responseWith({ [SettingName.NAMES.OcrServerAllowed]: 'false' })
      await makeController(true).recognize(recognizeRequest(), response)
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(ocrService.recognizePages).not.toHaveBeenCalled()
    })

    it('rejects a request with no pages', async () => {
      response = responseWith({ [SettingName.NAMES.OcrServerAllowed]: 'true' })
      await makeController(true).recognize({ body: { pages: [] } } as unknown as Request, response)
      expect(statusMock).toHaveBeenCalledWith(400)
    })

    it('decodes images and returns extracted text when enabled and allowed', async () => {
      response = responseWith({ [SettingName.NAMES.OcrServerAllowed]: 'true' })
      ocrService.recognizePages.mockResolvedValue([{ pageNumber: 1, text: 'hello' }])

      await makeController(true).recognize(recognizeRequest(), response)

      expect(ocrService.recognizePages).toHaveBeenCalledWith(
        [expect.objectContaining({ pageNumber: 1, image: expect.any(Buffer) })],
        undefined,
      )
      expect(jsonMock).toHaveBeenCalledWith({ pages: [{ pageNumber: 1, text: 'hello' }] })
    })

    it('maps a bounds error to 413', async () => {
      response = responseWith({ [SettingName.NAMES.OcrServerAllowed]: 'true' })
      ocrService.recognizePages.mockRejectedValue(new Error('Image for page 1 is too large: 99 bytes (max 10).'))

      await makeController(true).recognize(recognizeRequest(), response)
      expect(statusMock).toHaveBeenCalledWith(413)
    })
  })
})
