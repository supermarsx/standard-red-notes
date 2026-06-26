import * as net from 'net'
import * as tls from 'tls'

import { DeliveryChannel, DeliveryResult, ReminderDeliveryProvider } from '../Types'

/**
 * Standard Red Notes: Email delivery adapter.
 *
 * nodemailer is NOT a dependency of api-gateway (it lives in the auth package),
 * and the constraint is to avoid adding heavy deps to keep this feature
 * self-contained. So this adapter speaks a MINIMAL subset of SMTP over Node's
 * built-in `net`/`tls`: EHLO, optional STARTTLS, optional AUTH LOGIN, MAIL FROM,
 * RCPT TO, DATA. That is enough to relay a short plaintext reminder through a
 * standard SMTP server.
 *
 * Credentials come from the environment (SMTP_HOST / SMTP_PORT / SMTP_USER /
 * SMTP_PASSWORD / SMTP_FROM / SMTP_SECURE). The `destination` is the recipient
 * email address.
 *
 * NO-OP CONTRACT: when SMTP_HOST or SMTP_FROM is absent the adapter returns
 * `{ ok: false, notConfigured: true }` and opens NO socket. It never throws —
 * any transport/protocol error is mapped to `{ ok: false, reason }`.
 *
 * HONEST LIMITS (punch-list): plaintext body only (no MIME multipart /
 * attachments), AUTH LOGIN only (no XOAUTH2), and `secure` is implicit-TLS vs.
 * STARTTLS only. For richer needs, swap in nodemailer behind this same interface.
 */

export interface SmtpConfig {
  host?: string
  port?: number
  user?: string
  password?: string
  from?: string
  /** true => implicit TLS (e.g. port 465). false => plain, upgraded via STARTTLS when offered. */
  secure?: boolean
}

export class EmailProvider implements ReminderDeliveryProvider {
  readonly channel: DeliveryChannel = 'email'

  constructor(private readonly config: SmtpConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.host?.trim()) && Boolean(this.config.from?.trim())
  }

  async send(destination: string, message: string): Promise<DeliveryResult> {
    if (!this.isConfigured()) {
      return { ok: false, notConfigured: true, reason: 'SMTP is not configured (set SMTP_HOST and SMTP_FROM).' }
    }
    const to = (destination ?? '').trim()
    if (to.length === 0) {
      return { ok: false, reason: 'A recipient email address (destination) is required.' }
    }

    try {
      await this.relay(to, message)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `Email delivery failed: ${(error as Error).message}` }
    }
  }

  private async relay(to: string, message: string): Promise<void> {
    const host = this.config.host as string
    const port = this.config.port ?? (this.config.secure ? 465 : 587)
    const from = this.config.from as string

    const session = new SmtpSession(host, port, Boolean(this.config.secure))
    try {
      await session.connect()
      await session.expect(220)

      const ehloLines = await session.command(`EHLO standard-red-notes`, 250)

      // Opportunistic STARTTLS when the server advertises it and we're not already secure.
      if (!this.config.secure && /\bSTARTTLS\b/i.test(ehloLines.join('\n'))) {
        await session.command('STARTTLS', 220)
        await session.upgradeToTls(host)
        await session.command(`EHLO standard-red-notes`, 250)
      }

      if (this.config.user && this.config.password) {
        await session.command('AUTH LOGIN', 334)
        await session.command(Buffer.from(this.config.user).toString('base64'), 334)
        await session.command(Buffer.from(this.config.password).toString('base64'), 235)
      }

      await session.command(`MAIL FROM:<${stripBrackets(from)}>`, 250)
      await session.command(`RCPT TO:<${stripBrackets(to)}>`, 250)
      await session.command('DATA', 354)

      const body = buildMessage(from, to, message)
      await session.writeData(body)
      await session.expect(250)

      try {
        await session.command('QUIT', 221)
      } catch {
        // QUIT acknowledgement is best-effort.
      }
    } finally {
      session.close()
    }
  }
}

function stripBrackets(addr: string): string {
  return addr.replace(/^.*</, '').replace(/>.*$/, '').trim()
}

function buildMessage(from: string, to: string, message: string): string {
  const date = new Date().toUTCString()
  const subject = 'Reminder'
  // Escape leading-dot lines per SMTP "dot stuffing".
  const safeBody = message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
  return (
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `Date: ${date}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n` +
    `${safeBody}\r\n` +
    `.\r\n`
  )
}

/**
 * Tiny line-oriented SMTP client. Reads reply lines, matches the leading 3-digit
 * status code, and supports a STARTTLS upgrade. Deliberately small.
 */
class SmtpSession {
  private socket: net.Socket | tls.TLSSocket | null = null
  private buffer = ''
  private waiters: Array<(line: string) => void> = []

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly secure: boolean,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host }, () => resolve())
        : net.connect({ host: this.host, port: this.port }, () => resolve())
      socket.setEncoding('utf8')
      socket.once('error', onError)
      socket.on('data', (chunk: string) => this.onData(chunk))
      this.socket = socket
    })
  }

  upgradeToTls(servername: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket as net.Socket
      plain.removeAllListeners('data')
      const secure = tls.connect({ socket: plain, servername }, () => resolve())
      secure.setEncoding('utf8')
      secure.once('error', reject)
      secure.on('data', (chunk: string) => this.onData(chunk))
      this.socket = secure
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      const waiter = this.waiters.shift()
      if (waiter) {
        waiter(line)
      }
    }
  }

  /** Read one reply (possibly multi-line) and assert the status code. */
  async expect(code: number): Promise<string[]> {
    const lines: string[] = []
    // SMTP multi-line replies use "250-" for continuations and "250 " for the last.
    for (;;) {
      const line = await this.readLine()
      lines.push(line)
      const status = parseInt(line.slice(0, 3), 10)
      const isLast = line.charAt(3) !== '-'
      if (isLast) {
        if (status !== code) {
          throw new Error(`Expected SMTP ${code}, got: ${line}`)
        }
        return lines
      }
    }
  }

  async command(text: string, expectedCode: number): Promise<string[]> {
    this.write(`${text}\r\n`)
    return this.expect(expectedCode)
  }

  async writeData(body: string): Promise<void> {
    this.write(body)
  }

  private write(text: string): void {
    if (!this.socket) {
      throw new Error('SMTP socket is not connected.')
    }
    this.socket.write(text)
  }

  private readLine(): Promise<string> {
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  close(): void {
    try {
      this.socket?.destroy()
    } catch {
      // ignore
    }
    this.socket = null
  }
}
