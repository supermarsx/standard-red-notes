/// <reference types="jest" />

import {
  assertSafeMobileFileName,
  createContainedMobileFilePath,
  createTemporaryMobileFileName,
} from './MobileFilePathSecurity'

describe('MobileFilePathSecurity', () => {
  it.each(['../Library/sentinel', '..\\Library\\sentinel', 'folder/file.pdf', '.', '..', '\u0000secret'])(
    'rejects traversal filename %p before filesystem access',
    (filename) => {
      expect(() => createContainedMobileFilePath('/private/app/Documents', filename)).toThrow(
        'Invalid mobile file name',
      )
    },
  )

  it('cannot resolve a malicious attachment onto a sibling sentinel', () => {
    const sentinelPath = '/private/app/Library/sentinel'

    expect(() => createContainedMobileFilePath('/private/app/Documents', '../Library/sentinel')).toThrow()
    expect(createContainedMobileFilePath('/private/app/Documents', 'sentinel')).not.toBe(sentinelPath)
  })

  it('uses a generated safe basename for temporary shares while preserving a safe extension', () => {
    const temporaryName = createTemporaryMobileFileName('Quarterly report.pdf', 'fixed-token')

    expect(temporaryName).toBe('standard-red-notes-fixed-token.pdf')
    expect(temporaryName).not.toContain('Quarterly report')
    expect(createContainedMobileFilePath('/private/app/tmp/', temporaryName)).toBe(
      '/private/app/tmp/standard-red-notes-fixed-token.pdf',
    )
  })

  it('requires an absolute trusted destination directory', () => {
    expect(() => createContainedMobileFilePath('../tmp', 'report.pdf')).toThrow(
      'Mobile file directory must be absolute',
    )
    expect(() => createContainedMobileFilePath('/private/app/Documents/../Library', 'sentinel')).toThrow(
      'Mobile file directory must be absolute',
    )
    expect(assertSafeMobileFileName('report.pdf')).toBe('report.pdf')
  })
})
