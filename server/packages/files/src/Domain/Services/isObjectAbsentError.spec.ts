import { isObjectAbsentError } from './isObjectAbsentError'

describe('isObjectAbsentError', () => {
  it('recognises a Node fs ENOENT rejection', () => {
    const error = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })

    expect(isObjectAbsentError(error)).toBe(true)
  })

  it('recognises the S3 HeadObject NotFound rejection', () => {
    const error = Object.assign(new Error('NotFound'), { name: 'NotFound' })

    expect(isObjectAbsentError(error)).toBe(true)
  })

  it('recognises the S3 NoSuchKey rejection', () => {
    const error = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })

    expect(isObjectAbsentError(error)).toBe(true)
  })

  it('recognises a 404 carried only in the SDK response metadata', () => {
    const error = Object.assign(new Error('Not Found'), { $metadata: { httpStatusCode: 404 } })

    expect(isObjectAbsentError(error)).toBe(true)
  })

  it('does NOT treat a permissions failure as absence', () => {
    const error = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    })

    expect(isObjectAbsentError(error)).toBe(false)
  })

  it('does NOT treat an fs permissions or IO failure as absence', () => {
    expect(isObjectAbsentError(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toBe(false)
    expect(isObjectAbsentError(Object.assign(new Error('EIO'), { code: 'EIO' }))).toBe(false)
  })

  it('does NOT treat a storage outage as absence', () => {
    const error = Object.assign(new Error('Internal Error'), { $metadata: { httpStatusCode: 500 } })

    expect(isObjectAbsentError(error)).toBe(false)
  })

  it('handles non-object throws', () => {
    expect(isObjectAbsentError(undefined)).toBe(false)
    expect(isObjectAbsentError(null)).toBe(false)
    expect(isObjectAbsentError('ENOENT')).toBe(false)
  })
})
