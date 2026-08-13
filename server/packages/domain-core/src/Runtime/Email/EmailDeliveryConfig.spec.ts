import {
  EMAIL_DELIVERY_LIMITS,
  emailDeliveryConfigurationError,
  isEmailDeliveryConfigured,
  isTrustedInsecureRelayHost,
  resolveEmailDeliveryConfig,
  type ResolvedEmailDeliveryConfig,
  validateEmailRecipient,
  validateEmailSenderIdentity,
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

  it('validates every operator-facing SMTP setting without exposing its value', () => {
    const valid: ResolvedEmailDeliveryConfig = {
      host: 'smtp.example.com',
      port: 587,
      from: 'notes@example.com',
      tlsMode: 'starttls',
    }

    expect(emailDeliveryConfigurationError(valid)).toBeUndefined()
    expect(isEmailDeliveryConfigured(valid)).toBe(true)
    expect(emailDeliveryConfigurationError({ ...valid, port: 0 })).toContain('port')
    expect(emailDeliveryConfigurationError({ ...valid, from: 'not-an-email' })).toContain('From identity')
    expect(emailDeliveryConfigurationError({ ...valid, username: 'mailer\ninvalid', password: 'paired' })).toContain(
      'username',
    )
    expect(emailDeliveryConfigurationError({ ...valid, username: 'mailer', password: 'secret\0invalid' })).toContain(
      'password',
    )
    expect(
      emailDeliveryConfigurationError({
        ...valid,
        tlsMode: 'invalid' as ResolvedEmailDeliveryConfig['tlsMode'],
      }),
    ).toContain('TLS mode')
    expect(emailDeliveryConfigurationError({ ...valid, host: 'smtp.example.com', tlsMode: 'insecure' })).toContain(
      'Insecure SMTP',
    )
  })

  it('normalizes valid recipients and rejects non-string or malformed recipients', () => {
    expect(validateEmailRecipient(undefined)).toBeUndefined()
    expect(validateEmailRecipient(' notes@example.com ')).toBe('notes@example.com')
    expect(validateEmailRecipient("o'hara+notes@example-mail.com")).toBe("o'hara+notes@example-mail.com")
    expect(validateEmailRecipient('missing-at-sign.example.com')).toBeUndefined()
    expect(validateEmailRecipient('foo,bar@example.com')).toBeUndefined()
    expect(validateEmailRecipient('foo;bar@example.com')).toBeUndefined()
    expect(validateEmailRecipient('foo@example..com')).toBeUndefined()
    expect(validateEmailRecipient('foo@-example.com')).toBeUndefined()
    expect(validateEmailRecipient('.foo@example.com')).toBeUndefined()
    expect(validateEmailRecipient(`notes@${'x'.repeat(EMAIL_DELIVERY_LIMITS.recipient)}.com`)).toBeUndefined()
  })

  it('parses a conforming sender identity and rejects ambiguous display-name syntax', () => {
    expect(validateEmailSenderIdentity('Standard Red Notes <notes@example.com>')).toEqual({
      address: 'notes@example.com',
      name: 'Standard Red Notes',
    })
    expect(validateEmailSenderIdentity('notes@example.com')).toEqual({ address: 'notes@example.com' })
    expect(validateEmailSenderIdentity('@')).toBeUndefined()
    expect(validateEmailSenderIdentity('<notes@example.com>')).toBeUndefined()
    expect(validateEmailSenderIdentity('Notes <notes@example.com> trailing')).toBeUndefined()
  })

  it('allows insecure SMTP only for literal loopback/private/link-local IPs and localhost names', () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.2',
      '169.254.10.1',
      '::1',
      '[::1]',
      'fc00::1',
      'fd00::1',
      'fe80::1',
      'localhost',
      'smtp.localhost',
    ]) {
      expect(isTrustedInsecureRelayHost(host)).toBe(true)
    }
    for (const host of [
      'mail-relay',
      'smtp.example.com',
      '8.8.8.8',
      '169.253.10.1',
      '172.15.0.1',
      '172.32.0.1',
      '192.167.1.2',
      '2001:4860:4860::8888',
    ]) {
      expect(isTrustedInsecureRelayHost(host)).toBe(false)
    }
  })
})
