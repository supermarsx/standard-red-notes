import {
  emailDeliveryConfigurationError,
  isEmailDeliveryConfigured,
  isTrustedInsecureRelayHost,
  resolveEmailDeliveryConfig,
  validateEmailRecipient,
} from './EmailDeliveryConfig'

describe('EmailDeliveryConfig', () => {
  it('resolves persisted fields over environment fields and mode-aware defaults', () => {
    expect(
      resolveEmailDeliveryConfig(
        { host: 'smtp.saved.test', from: 'saved@example.com', tlsMode: 'implicit' },
        { host: 'smtp.env.test', username: 'env-user', password: 'env-pass', from: 'env@example.com' },
      ),
    ).toEqual({
      host: 'smtp.saved.test',
      port: 465,
      username: 'env-user',
      password: 'env-pass',
      from: 'saved@example.com',
      tlsMode: 'implicit',
    })
  })

  it('requires paired credentials and rejects header injection', () => {
    const unpaired = resolveEmailDeliveryConfig(
      { host: 'smtp.example.com', username: 'mailer', from: 'notes@example.com' },
      undefined,
    )
    expect(emailDeliveryConfigurationError(unpaired)).toContain('configured together')
    expect(
      isEmailDeliveryConfigured(
        resolveEmailDeliveryConfig({ host: 'smtp.example.com\r\nX-Bad: yes', from: 'notes@example.com' }, undefined),
      ),
    ).toBe(false)
    expect(validateEmailRecipient('victim@example.com\r\nBcc: other@example.com')).toBeUndefined()
  })

  it('allows insecure SMTP only for literal loopback/private/link-local IPs and localhost names', () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.2',
      '169.254.10.1',
      '::1',
      'fd00::1',
      'smtp.localhost',
    ]) {
      expect(isTrustedInsecureRelayHost(host)).toBe(true)
    }
    for (const host of ['mail-relay', 'smtp.example.com', '8.8.8.8', '2001:4860:4860::8888']) {
      expect(isTrustedInsecureRelayHost(host)).toBe(false)
    }
  })
})
