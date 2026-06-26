import { DeliveryChannel, DeliveryResult, ReminderDeliveryProvider } from '../Types'

/**
 * Standard Red Notes: WhatsApp delivery adapter.
 *
 * Supports two interchangeable backends, selected by which env credentials are
 * present (Meta is preferred when both are configured):
 *
 *   - Meta WhatsApp Cloud API: `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID`. Sends a
 *     text message to `https://graph.facebook.com/v19.0/<phoneId>/messages`.
 *   - Twilio: `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_WHATSAPP_FROM`.
 *     Sends via the Twilio Messages API with `whatsapp:` addressing.
 *
 * NO-OP CONTRACT: when neither backend is fully configured the adapter returns
 * `{ ok: false, notConfigured: true }` and makes NO network call. It never throws.
 *
 * Uses the Node 22 global `fetch` (no extra dependency).
 *
 * HONEST LIMITS (punch-list): Meta only delivers free-form text inside the 24h
 * customer-service window; outside it a pre-approved template is required. This
 * adapter sends plain text and surfaces the API error otherwise.
 */

export interface WhatsAppMetaCreds {
  token: string
  phoneId: string
}

export interface WhatsAppTwilioCreds {
  accountSid: string
  authToken: string
  from: string
}

export interface WhatsAppProviderConfig {
  meta?: Partial<WhatsAppMetaCreds>
  twilio?: Partial<WhatsAppTwilioCreds>
}

export class WhatsAppProvider implements ReminderDeliveryProvider {
  readonly channel: DeliveryChannel = 'whatsapp'

  constructor(
    private readonly config: WhatsAppProviderConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch?.bind(globalThis),
  ) {}

  private metaCreds(): WhatsAppMetaCreds | null {
    const token = this.config.meta?.token?.trim()
    const phoneId = this.config.meta?.phoneId?.trim()
    if (token && phoneId) {
      return { token, phoneId }
    }
    return null
  }

  private twilioCreds(): WhatsAppTwilioCreds | null {
    const accountSid = this.config.twilio?.accountSid?.trim()
    const authToken = this.config.twilio?.authToken?.trim()
    const from = this.config.twilio?.from?.trim()
    if (accountSid && authToken && from) {
      return { accountSid, authToken, from }
    }
    return null
  }

  isConfigured(): boolean {
    return this.metaCreds() !== null || this.twilioCreds() !== null
  }

  async send(destination: string, message: string): Promise<DeliveryResult> {
    const to = (destination ?? '').trim()
    const meta = this.metaCreds()
    const twilio = this.twilioCreds()

    if (!meta && !twilio) {
      return {
        ok: false,
        notConfigured: true,
        reason: 'WhatsApp is not configured (set WHATSAPP_TOKEN+WHATSAPP_PHONE_ID or TWILIO_*).',
      }
    }
    if (to.length === 0) {
      return { ok: false, reason: 'A WhatsApp destination (phone number) is required.' }
    }
    if (typeof this.fetchImpl !== 'function') {
      return { ok: false, reason: 'No fetch implementation available for WhatsApp delivery.' }
    }

    if (meta) {
      return this.sendViaMeta(meta, to, message)
    }
    return this.sendViaTwilio(twilio as WhatsAppTwilioCreds, to, message)
  }

  private async sendViaMeta(creds: WhatsAppMetaCreds, to: string, message: string): Promise<DeliveryResult> {
    const url = `https://graph.facebook.com/v19.0/${creds.phoneId}/messages`
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: message },
        }),
      })
      if (!res.ok) {
        const detail = await safeText(res)
        return { ok: false, reason: `WhatsApp (Meta) API returned ${res.status}${detail ? `: ${detail}` : ''}` }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `WhatsApp (Meta) delivery failed: ${(error as Error).message}` }
    }
  }

  private async sendViaTwilio(creds: WhatsAppTwilioCreds, to: string, message: string): Promise<DeliveryResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`
    const form = new URLSearchParams()
    form.set('To', to.startsWith('whatsapp:') ? to : `whatsapp:${to}`)
    form.set('From', creds.from.startsWith('whatsapp:') ? creds.from : `whatsapp:${creds.from}`)
    form.set('Body', message)
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      })
      if (!res.ok) {
        const detail = await safeText(res)
        return { ok: false, reason: `WhatsApp (Twilio) API returned ${res.status}${detail ? `: ${detail}` : ''}` }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `WhatsApp (Twilio) delivery failed: ${(error as Error).message}` }
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return ''
  }
}
