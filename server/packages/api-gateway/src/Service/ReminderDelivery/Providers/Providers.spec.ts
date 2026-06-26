import { TelegramProvider } from './TelegramProvider'
import { EmailProvider } from './EmailProvider'
import { WhatsAppProvider } from './WhatsAppProvider'

/**
 * The core "unconfigured adapter NO-OPs" contract: with no credentials each
 * adapter must return { ok: false, notConfigured: true }, perform NO network
 * call, and never throw. Also covers the happy-path wiring for Telegram /
 * WhatsApp via an injected fetch (Email's SMTP socket path is covered by the
 * no-op + missing-destination cases without opening a socket).
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
      const [url] = fetchImpl.mock.calls[0]
      expect(url).toBe('https://graph.facebook.com/v19.0/99/messages')
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
  })
})
