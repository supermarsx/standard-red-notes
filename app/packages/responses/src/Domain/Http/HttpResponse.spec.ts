import { ErrorTag } from './ErrorTag'
import { HttpErrorResponse, HttpResponse } from './HttpResponse'
import {
  getCaptchaHeader,
  getErrorFromErrorResponse,
  getErrorMessageFromErrorResponseBody,
  isErrorResponse,
} from './HttpResponse'
import { HttpStatusCode } from './HttpStatusCode'

describe('HttpResponse', () => {
  describe('isErrorResponse', () => {
    it('should be true when the body carries an error, even on a 2xx status', () => {
      const response: HttpResponse = {
        status: HttpStatusCode.Success,
        data: { error: { message: 'nope' } },
      }

      expect(isErrorResponse(response)).toBe(true)
    })

    it('should be true when the status is 400 or above without an error body', () => {
      const response: HttpResponse = {
        status: HttpStatusCode.BadRequest,
        data: {},
      }

      expect(isErrorResponse(response)).toBe(true)
    })

    it('should be false for a success status with a plain data body', () => {
      const response: HttpResponse = {
        status: HttpStatusCode.Success,
        data: { foo: 'bar' },
      }

      expect(isErrorResponse(response)).toBe(false)
    })

    it('should be false for status 300, the highest non-error status', () => {
      const response: HttpResponse = {
        status: HttpStatusCode.MultipleChoices,
        data: {},
      }

      expect(isErrorResponse(response)).toBe(false)
    })

    it('should not throw and should fall back to the status when data is null', () => {
      const response = {
        status: HttpStatusCode.Success,
        data: null,
      } as unknown as HttpResponse

      expect(isErrorResponse(response)).toBe(false)
    })

    it('should treat a null-data response with an error status as an error', () => {
      const response = {
        status: HttpStatusCode.InternalServerError,
        data: null,
      } as unknown as HttpResponse

      expect(isErrorResponse(response)).toBe(true)
    })

    it('should be false when the error key is present but undefined and the status is fine', () => {
      const response = {
        status: HttpStatusCode.NoContent,
        data: { error: undefined },
      } as unknown as HttpResponse

      expect(isErrorResponse(response)).toBe(false)
    })
  })

  describe('getCaptchaHeader', () => {
    it('should return the header value when present', () => {
      const response: HttpResponse = {
        status: HttpStatusCode.Forbidden,
        data: {},
        headers: new Map([['x-captcha-required', 'https://captcha.example/challenge']]),
      }

      expect(getCaptchaHeader(response)).toBe('https://captcha.example/challenge')
    })

    it('should return null when the header is absent', () => {
      const response: HttpResponse = {
        status: HttpStatusCode.Forbidden,
        data: {},
        headers: new Map([['content-type', 'application/json']]),
      }

      expect(getCaptchaHeader(response)).toBeNull()
    })

    it('should return null when the header is present but empty', () => {
      const response: HttpResponse = {
        status: HttpStatusCode.Forbidden,
        data: {},
        headers: new Map([['x-captcha-required', '']]),
      }

      expect(getCaptchaHeader(response)).toBeNull()
    })

    it('should return null when there are no headers at all', () => {
      const response: HttpResponse = {
        status: HttpStatusCode.Success,
        data: {},
      }

      expect(getCaptchaHeader(response)).toBeNull()
    })
  })

  describe('getErrorMessageFromErrorResponseBody', () => {
    it('should return the embedded error message', () => {
      expect(getErrorMessageFromErrorResponseBody({ error: { message: 'Invalid password' } })).toBe('Invalid password')
    })

    it('should prefer the embedded message over the supplied default', () => {
      expect(getErrorMessageFromErrorResponseBody({ error: { message: 'Invalid password' } }, 'Default')).toBe(
        'Invalid password',
      )
    })

    it('should return the supplied default when there is no error', () => {
      expect(getErrorMessageFromErrorResponseBody({}, 'Default')).toBe('Default')
    })

    it('should return "Unknown error" when there is no error and no default', () => {
      expect(getErrorMessageFromErrorResponseBody({})).toBe('Unknown error')
    })

    it('should return the default when data is null', () => {
      expect(getErrorMessageFromErrorResponseBody(null as never, 'Default')).toBe('Default')
    })

    it('should return the default when the error is not an object', () => {
      expect(getErrorMessageFromErrorResponseBody({ error: 'a string' } as never, 'Default')).toBe('Default')
    })

    it('should return the default when the error object has no message key', () => {
      expect(getErrorMessageFromErrorResponseBody({ error: { tag: ErrorTag.MfaRequired } } as never, 'Default')).toBe(
        'Default',
      )
    })

    it('should return the default when data is not an object', () => {
      expect(getErrorMessageFromErrorResponseBody('boom' as never, 'Default')).toBe('Default')
    })
  })

  describe('getErrorFromErrorResponse', () => {
    it('should return the embedded error object by reference', () => {
      const error = { message: 'Rate limited', tag: ErrorTag.AuthInvalid }
      const response: HttpErrorResponse = {
        status: HttpStatusCode.Forbidden,
        data: { error },
      }

      expect(getErrorFromErrorResponse(response)).toBe(error)
    })

    it('should synthesise an unknown error when the body has no error', () => {
      const response: HttpErrorResponse = {
        status: HttpStatusCode.InternalServerError,
        data: {},
      }

      expect(getErrorFromErrorResponse(response)).toEqual({ message: 'Unknown error' })
    })
  })
})
