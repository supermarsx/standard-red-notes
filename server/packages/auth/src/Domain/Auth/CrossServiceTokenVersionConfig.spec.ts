import {
  resolveCrossServiceTokenVersionConfig,
  SECURE_CROSS_SERVICE_TOKEN_VERSION_THRESHOLD,
} from './CrossServiceTokenVersionConfig'

describe('resolveCrossServiceTokenVersionConfig', () => {
  it.each([
    [undefined, undefined],
    ['', '   '],
    ['not-semver', '1.x'],
  ])('fails secure when thresholds are absent or invalid', (version2, version3) => {
    expect(resolveCrossServiceTokenVersionConfig(version2, version3)).toEqual({
      version2Threshold: SECURE_CROSS_SERVICE_TOKEN_VERSION_THRESHOLD,
      version3Threshold: SECURE_CROSS_SERVICE_TOKEN_VERSION_THRESHOLD,
      defaultedConfigurationKeys: [
        'APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2',
        'APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3',
      ],
    })
  })

  it('normalizes valid operator thresholds without reporting a fallback', () => {
    expect(resolveCrossServiceTokenVersionConfig(' 1.2.3 ', 'v2.3.4')).toEqual({
      version2Threshold: '1.2.3',
      version3Threshold: '2.3.4',
      defaultedConfigurationKeys: [],
    })
  })

  it('reports only the malformed threshold when the other value is valid', () => {
    expect(resolveCrossServiceTokenVersionConfig('1.2.3', 'invalid')).toEqual({
      version2Threshold: '1.2.3',
      version3Threshold: SECURE_CROSS_SERVICE_TOKEN_VERSION_THRESHOLD,
      defaultedConfigurationKeys: ['APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3'],
    })
  })
})
