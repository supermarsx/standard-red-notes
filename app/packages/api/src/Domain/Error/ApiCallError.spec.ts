import { XMLHttpRequestState } from '../Http/XMLHttpRequestState'
import { ApiCallError } from './ApiCallError'
import { ErrorMessage } from './ErrorMessage'

describe('ApiCallError', () => {
  it('should carry the message', () => {
    expect(new ApiCallError('boom').message).toBe('boom')
  })

  it('should be an instance of both ApiCallError and Error', () => {
    const error = new ApiCallError('boom')

    expect(error).toBeInstanceOf(ApiCallError)
    expect(error).toBeInstanceOf(Error)
  })

  it('should survive an instanceof check after being thrown and caught', () => {
    try {
      throw new ApiCallError(ErrorMessage.GenericFail)
    } catch (error) {
      expect(error instanceof ApiCallError).toBe(true)
      expect((error as ApiCallError).message).toBe(ErrorMessage.GenericFail)
    }
  })
})

describe('XMLHttpRequestState', () => {
  it('should pin the DONE ready state', () => {
    expect(XMLHttpRequestState.Completed).toBe(4)
  })
})
