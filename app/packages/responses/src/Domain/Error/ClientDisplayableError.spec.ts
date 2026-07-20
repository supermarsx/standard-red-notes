import { ErrorTag } from '../Http/ErrorTag'
import { HttpErrorResponse } from '../Http/HttpResponse'
import { HttpStatusCode } from '../Http/HttpStatusCode'
import { ClientDisplayableError, isClientDisplayableError } from './ClientDisplayableError'

describe('ClientDisplayableError', () => {
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('should expose the text, title and tag it was constructed with', () => {
    const error = new ClientDisplayableError('Something broke', 'Sync', 'sync-tag')

    expect(error.text).toBe('Something broke')
    expect(error.title).toBe('Sync')
    expect(error.tag).toBe('sync-tag')
  })

  it('should log the error, substituting empty strings for the optional fields', () => {
    new ClientDisplayableError('Something broke')

    expect(consoleError).toHaveBeenCalledWith('Client Displayable Error:', 'Something broke', '', '')
  })

  it('should log the title and tag when they are supplied', () => {
    new ClientDisplayableError('Something broke', 'Sync', 'sync-tag')

    expect(consoleError).toHaveBeenCalledWith('Client Displayable Error:', 'Something broke', 'Sync', 'sync-tag')
  })

  describe('FromError', () => {
    it('should map message to text and keep the tag, leaving the title undefined', () => {
      const error = ClientDisplayableError.FromError({ message: 'Bad request', tag: ErrorTag.ParametersInvalid })

      expect(error.text).toBe('Bad request')
      expect(error.title).toBeUndefined()
      expect(error.tag).toBe(ErrorTag.ParametersInvalid)
    })

    it('should leave the tag undefined when the source error has none', () => {
      const error = ClientDisplayableError.FromError({ message: 'Bad request' })

      expect(error.tag).toBeUndefined()
    })
  })

  describe('FromString', () => {
    it('should use the string as the text with no title or tag', () => {
      const error = ClientDisplayableError.FromString('Plain message')

      expect(error.text).toBe('Plain message')
      expect(error.title).toBeUndefined()
      expect(error.tag).toBeUndefined()
    })
  })

  describe('FromNetworkError', () => {
    it('should use the embedded server error message', () => {
      const response: HttpErrorResponse = {
        status: HttpStatusCode.Unauthorized,
        data: { error: { message: 'Invalid login credentials.' } },
      }

      expect(ClientDisplayableError.FromNetworkError(response).text).toBe('Invalid login credentials.')
    })

    it('should fall back to "Unknown error" when the response carries no error', () => {
      const response: HttpErrorResponse = {
        status: HttpStatusCode.InternalServerError,
        data: {},
      }

      expect(ClientDisplayableError.FromNetworkError(response).text).toBe('Unknown error')
    })
  })

  describe('isClientDisplayableError', () => {
    it('should be true for an instance', () => {
      expect(isClientDisplayableError(new ClientDisplayableError('x'))).toBe(true)
    })

    it('should be false for a structurally similar plain object', () => {
      expect(isClientDisplayableError({ text: 'x', title: undefined, tag: undefined })).toBe(false)
    })

    it('should be false for undefined and for a plain Error', () => {
      expect(isClientDisplayableError(undefined)).toBe(false)
      expect(isClientDisplayableError(new Error('x'))).toBe(false)
    })
  })
})
