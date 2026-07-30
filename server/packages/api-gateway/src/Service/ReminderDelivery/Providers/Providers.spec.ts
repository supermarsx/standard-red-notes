import { TelegramProvider } from './TelegramProvider'
import { EmailProvider } from './EmailProvider'
import { WhatsAppProvider } from './WhatsAppProvider'

const failedResponse = (status: number, detail: string): Response =>
  ({
    ok: false,
    status,
    text: jest.fn().mockResolvedValue(detail),
  }) as unknown as Response

const abortingFetch = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  })
})

/**
 * The core "unconfigured adapter NO-OPs" contract: with no credentials each
 * adapter must return { ok: false, notConfigured: true }, perform NO network
 * call, and never throw. Also covers the happy-path wiring for Telegram /
 * WhatsApp via an injected fetch. Email's protocol and timeout paths are covered
 * against a loopback SMTP fixture in EmailProvider.spec.
 */
describe('ReminderDelivery providers (no-op when unconfigured)', () => {
  describe('TelegramProvider', () => {
    it('no-ops with notConfigured when the bot token is absent, making no fetch call', async () => {
      const fetchImpl = jest.fn()
      const provider = new TelegramProvider(undefined, fetchImpl as unknown as typeof fetch)
      const result = await provider.send('chat-1', 'hi')
      expect(result).toEqual(expect.objectContaining({ ok: false, notConfigured: true }))
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('treats an empty/whitespace token as unconfigured', async () => {
      const provider = new TelegramProvider('   ')
      expect(provider.isConfigured()).toBe(false)
    })

    it('POSTs to the Bot API when configured', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({ ok: true })
      const provider = new TelegramProvider('BOT123', fetchImpl as unknown as typeof fetch)
      const result = await provider.send('chat-1', 'hello')
      expect(result.ok).toBe(true)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [url, init] = fetchImpl.mock.calls[0]
      expect(url).toBe('https://api.telegram.org/botBOT123/sendMessage')
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
      expect(JSON.parse((init as { body: string }).body)).toEqual(
        expect.objectContaining({ chat_id: 'chat-1', text: 'hello' }),
      )
    })

    it('does not throw on a transport error; reports the failure', async () => {
      const fetchImpl = jest.fn().mockRejectedValue(new Error('network down'))
      const provider = new TelegramProvider('BOT123', fetchImpl as unknown as typeof fetch)
      const result = await provider.send('chat-1', 'hello')
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('network down')
    })

    it('times out a fetch that never settles', async () => {
      const provider = new TelegramProvider('BOT123', abortingFetch as unknown as typeof fetch, 10)

      const result = await provider.send('chat-1', 'hello')

      expect(result).toEqual({ ok: false, reason: 'Telegram delivery timed out.' })
    })

    it('bounds and redacts credentials from API and transport errors', async () => {
      const token = 'BOT123-secret-token'
      const chatId = 'private-chat-id'
      const message = 'private reminder content'
      const responseFetch = jest
        .fn()
        .mockResolvedValue(failedResponse(400, `token=${token}; chat=${chatId}; text=${message}\r\n${'x'.repeat(500)}`))
      const responseResult = await new TelegramProvider(token, responseFetch as unknown as typeof fetch).send(
        chatId,
        message,
      )
      const transportFetch = jest
        .fn()
        .mockRejectedValue(
          new Error(`request to https://api.telegram.org/bot${token}/sendMessage for ${chatId} with ${message} failed`),
        )
      const transportResult = await new TelegramProvider(token, transportFetch as unknown as typeof fetch).send(
        chatId,
        message,
      )

      expect(responseResult.reason).not.toContain(token)
      expect(responseResult.reason).not.toContain(chatId)
      expect(responseResult.reason).not.toContain(message)
      expect(responseResult.reason?.length).toBeLessThanOrEqual(335)
      expect(responseResult.reason).not.toContain('\r')
      expect(responseResult.reason).not.toContain('\n')
      expect(transportResult.reason).not.toContain(token)
      expect(transportResult.reason).not.toContain(chatId)
      expect(transportResult.reason).not.toContain(message)
    })
  })

  describe('EmailProvider', () => {
    it('no-ops with notConfigured when SMTP is absent', async () => {
      const provider = new EmailProvider({})
      const result = await provider.send('a@b.com', 'hi')
      expect(result).toEqual(expect.objectContaining({ ok: false, notConfigured: true }))
    })

    it('requires both host and from to be considered configured', () => {
      expect(new EmailProvider({ host: 'smtp.example.com' }).isConfigured()).toBe(false)
      expect(new EmailProvider({ from: 'me@example.com' }).isConfigured()).toBe(false)
      expect(new EmailProvider({ host: 'smtp.example.com', from: 'me@example.com' }).isConfigured()).toBe(true)
    })
  })

  describe('WhatsAppProvider', () => {
    it('no-ops with notConfigured when neither Meta nor Twilio creds are set', async () => {
      const fetchImpl = jest.fn()
      const provider = new WhatsAppProvider({}, fetchImpl as unknown as typeof fetch)
      const result = await provider.send('+15551234567', 'hi')
      expect(result).toEqual(expect.objectContaining({ ok: false, notConfigured: true }))
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('uses the Meta Cloud API when Meta creds are present', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({ ok: true })
      const provider = new WhatsAppProvider(
        { meta: { token: 'META', phoneId: '99' } },
        fetchImpl as unknown as typeof fetch,
      )
      const result = await provider.send('+15551234567', 'hello')
      expect(result.ok).toBe(true)
      const [url, init] = fetchImpl.mock.calls[0]
      expect(url).toBe('https://graph.facebook.com/v19.0/99/messages')
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
    })

    it('falls back to Twilio when only Twilio creds are present', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({ ok: true })
      const provider = new WhatsAppProvider(
        { twilio: { accountSid: 'AC1', authToken: 'tok', from: '+15550000000' } },
        fetchImpl as unknown as typeof fetch,
      )
      const result = await provider.send('+15551234567', 'hello')
      expect(result.ok).toBe(true)
      const [url, init] = fetchImpl.mock.calls[0]
      expect(url).toContain('api.twilio.com')
      expect((init as { body: string }).body).toContain('whatsapp%3A%2B15551234567')
    })

    it('times out a fetch that never settles', async () => {
      const provider = new WhatsAppProvider(
        { meta: { token: 'META', phoneId: '99' } },
        abortingFetch as unknown as typeof fetch,
        10,
      )

      const result = await provider.send('+15551234567', 'hello')

      expect(result).toEqual({ ok: false, reason: 'WhatsApp (Meta) delivery timed out.' })
    })

    it('bounds and redacts Meta credentials from API errors', async () => {
      const token = 'META-secret-token'
      const phoneId = 'phone-secret-id'
      const destination = '+15551234567'
      const message = 'private reminder content'
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(
          failedResponse(
            401,
            `token=${token}; phone=${phoneId}; to=${destination}; text=${message}; ${'x'.repeat(500)}`,
          ),
        )
      const provider = new WhatsAppProvider({ meta: { token, phoneId } }, fetchImpl as unknown as typeof fetch)

      const result = await provider.send(destination, message)

      expect(result.reason).not.toContain(token)
      expect(result.reason).not.toContain(phoneId)
      expect(result.reason).not.toContain(destination)
      expect(result.reason).not.toContain(message)
      expect(result.reason?.length).toBeLessThanOrEqual(345)
    })

    it('redacts Twilio credentials and derived authorization from transport errors', async () => {
      const accountSid = 'AC-secret'
      const authToken = 'twilio-secret'
      const from = '+15550000000'
      const destination = '+15551234567'
      const message = 'private reminder content'
      const authorization = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
      const fetchImpl = jest
        .fn()
        .mockRejectedValue(
          new Error(
            `sid=${accountSid} token=${authToken} from=${from} to=${destination} text=${message} basic=${authorization}`,
          ),
        )
      const provider = new WhatsAppProvider(
        { twilio: { accountSid, authToken, from } },
        fetchImpl as unknown as typeof fetch,
      )

      const result = await provider.send(destination, message)

      expect(result.reason).not.toContain(accountSid)
      expect(result.reason).not.toContain(authToken)
      expect(result.reason).not.toContain(from)
      expect(result.reason).not.toContain(destination)
      expect(result.reason).not.toContain(message)
      expect(result.reason).not.toContain(authorization)
    })
  })
})
