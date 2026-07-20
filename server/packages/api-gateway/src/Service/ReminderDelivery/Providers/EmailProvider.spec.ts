import * as net from 'net'

import { EmailProvider } from './EmailProvider'

const CRLF = '\r\n'

/**
 * Standard Red Notes: EmailProvider speaks raw SMTP over a socket, so it is
 * exercised here against a REAL in-process SMTP server bound to 127.0.0.1. No
 * external network and no new dependency — the fixture below is ~50 lines of
 * `net`, and it lets every protocol step (greeting, EHLO, AUTH LOGIN, MAIL/RCPT,
 * DATA, dot-stuffing, QUIT, error replies) be asserted on the bytes the provider
 * actually put on the wire.
 *
 * NOT covered here: the implicit-TLS and STARTTLS upgrade paths, which need a
 * certificate fixture; they are left uncovered rather than faked.
 */
interface FakeSmtp {
  port: number
  /** Every line the client sent, in order. */
  received: string[]
  close(): Promise<void>
}

/**
 * `script` maps an incoming command line to the reply to send. Returning null
 * closes the connection instead of replying.
 *
 * KNOWN PRODUCT BUG (reported, deliberately not worked around in the source):
 * SmtpSession.onData() drains every complete line it finds in one synchronous
 * loop and DISCARDS any line for which no reader is currently waiting, while
 * expect() only registers the next waiter on a microtask after the previous line
 * resolves. A MULTI-LINE reply arriving in a single TCP segment — what every
 * real server sends for EHLO — therefore loses its trailing line, and the client
 * then waits forever because nothing in the SMTP path has a timeout. This
 * fixture only ever sends single-line replies so the rest of the protocol can be
 * covered deterministically.
 */
const startFakeSmtp = async (
  script: (line: string, sent: string[]) => string | null,
  greeting = '220 fake ESMTP ready',
): Promise<FakeSmtp> => {
  const received: string[] = []
  const sockets: net.Socket[] = []

  // One turn of the event loop later, so the client has registered its reader.
  const writeReply = (socket: net.Socket, reply: string): void => {
    setTimeout(() => socket.write(reply + CRLF), 5)
  }

  const server = net.createServer((socket) => {
    sockets.push(socket)
    let inData = false
    let buffer = ''
    socket.setEncoding('utf8')
    writeReply(socket, greeting)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        received.push(line)
        if (inData) {
          if (line === '.') {
            inData = false
            writeReply(socket, '250 queued')
          }
          continue
        }
        const reply = script(line, received)
        if (reply === null) {
          socket.destroy()
          return
        }
        if (line.toUpperCase().startsWith('DATA')) {
          inData = true
        }
        writeReply(socket, reply)
      }
    })
    socket.on('error', () => undefined)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    port: (server.address() as net.AddressInfo).port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        // server.close() only stops accepting; a lingering client socket would
        // keep the server (and the jest worker) alive.
        for (const socket of sockets) {
          socket.destroy()
        }
        server.close(() => resolve())
      }),
  }
}

/** A well-behaved server that accepts everything. */
const defaultScript = (line: string): string | null => {
  const verb = line.toUpperCase()
  if (verb.startsWith('EHLO')) {
    return '250 fake greets you'
  }
  if (verb.startsWith('DATA')) {
    return '354 send it'
  }
  if (verb.startsWith('QUIT')) {
    return '221 bye'
  }
  return '250 ok'
}

describe('EmailProvider', () => {
  const servers: FakeSmtp[] = []

  afterEach(async () => {
    while (servers.length > 0) {
      await (servers.pop() as FakeSmtp).close()
    }
  })

  const start = async (...args: Parameters<typeof startFakeSmtp>): Promise<FakeSmtp> => {
    const server = await startFakeSmtp(...args)
    servers.push(server)
    return server
  }

  it('relays a reminder through the full SMTP conversation', async () => {
    const smtp = await start(defaultScript)

    const provider = new EmailProvider({
      host: '127.0.0.1',
      port: smtp.port,
      from: 'Reminders <reminders@example.com>',
    })

    const result = await provider.send('user@example.com', 'Water the plants')

    expect(result).toEqual({ ok: true })
    expect(smtp.received).toEqual(
      expect.arrayContaining([
        'EHLO standard-red-notes',
        // The display name must be stripped from the envelope address.
        'MAIL FROM:<reminders@example.com>',
        'RCPT TO:<user@example.com>',
        'DATA',
        'QUIT',
      ]),
    )
    // Headers and body land inside the DATA block, terminated by a lone dot.
    expect(smtp.received).toEqual(
      expect.arrayContaining(['To: user@example.com', 'Subject: Reminder', 'Water the plants', '.']),
    )
  })

  it('dot-stuffs a body line that begins with a period', async () => {
    const smtp = await start(defaultScript)

    const provider = new EmailProvider({ host: '127.0.0.1', port: smtp.port, from: 'me@example.com' })

    const result = await provider.send('user@example.com', '.hidden\n.. already stuffed')

    expect(result).toEqual({ ok: true })
    expect(smtp.received).toEqual(expect.arrayContaining(['..hidden', '... already stuffed']))
    // Exactly one bare '.' — the terminator — must reach the server.
    expect(smtp.received.filter((line) => line === '.')).toHaveLength(1)
  })

  it('performs AUTH LOGIN with base64 credentials when a user and password are configured', async () => {
    const encodedUser = Buffer.from('smtp-user').toString('base64')
    const encodedPassword = Buffer.from('s3cr3t').toString('base64')

    const smtp = await start((line) => {
      if (line.toUpperCase().startsWith('AUTH LOGIN')) {
        return '334 VXNlcm5hbWU6'
      }
      if (line === encodedUser) {
        return '334 UGFzc3dvcmQ6'
      }
      if (line === encodedPassword) {
        return '235 authenticated'
      }
      return defaultScript(line)
    })

    const provider = new EmailProvider({
      host: '127.0.0.1',
      port: smtp.port,
      from: 'me@example.com',
      user: 'smtp-user',
      password: 's3cr3t',
    })

    const result = await provider.send('user@example.com', 'hi')

    expect(result).toEqual({ ok: true })
    expect(smtp.received).toEqual(expect.arrayContaining(['AUTH LOGIN', encodedUser, encodedPassword]))
    // The password must never travel in the clear.
    expect(smtp.received).not.toContain('s3cr3t')
  })

  it('does not authenticate when only a user (no password) is configured', async () => {
    const smtp = await start(defaultScript)

    const provider = new EmailProvider({
      host: '127.0.0.1',
      port: smtp.port,
      from: 'me@example.com',
      user: 'smtp-user',
    })

    const result = await provider.send('user@example.com', 'hi')

    expect(result).toEqual({ ok: true })
    expect(smtp.received).not.toContain('AUTH LOGIN')
  })

  it('reports the failing reply when the server rejects the recipient', async () => {
    const smtp = await start((line) => {
      return line.toUpperCase().startsWith('RCPT TO') ? '550 no such user' : defaultScript(line)
    })

    const provider = new EmailProvider({ host: '127.0.0.1', port: smtp.port, from: 'me@example.com' })

    const result = await provider.send('nobody@example.com', 'hi')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Expected SMTP 250')
    expect(result.reason).toContain('550 no such user')
    // A protocol rejection is a delivery failure, not a configuration problem.
    expect(result.notConfigured).toBeUndefined()
    // Nothing was submitted: the client must not have reached DATA.
    expect(smtp.received).not.toContain('DATA')
  })

  it('reports a failure when the greeting is not 220', async () => {
    const smtp = await start(defaultScript, '421 service not available')

    const provider = new EmailProvider({ host: '127.0.0.1', port: smtp.port, from: 'me@example.com' })

    const result = await provider.send('user@example.com', 'hi')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Expected SMTP 220')
    expect(smtp.received).toEqual([])
  })

  // NOTE: there is deliberately no test for "the server drops the connection
  // mid-conversation". SmtpSession.readLine() resolves only when a line arrives
  // and is never rejected on 'close' or 'error', so send() hangs forever instead
  // of failing. That is a product bug, reported separately — a test for it would
  // hang the suite rather than go red.

  it('reports a transport failure when nothing is listening', async () => {
    // Bind then immediately release a port so it is almost certainly closed.
    const smtp = await startFakeSmtp(defaultScript)
    const deadPort = smtp.port
    await smtp.close()

    const provider = new EmailProvider({ host: '127.0.0.1', port: deadPort, from: 'me@example.com' })

    const result = await provider.send('user@example.com', 'hi')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Email delivery failed:')
  })

  it('no-ops without opening a socket when SMTP is not configured', async () => {
    const connectSpy = jest.spyOn(net, 'connect')

    const result = await new EmailProvider({ from: 'me@example.com' }).send('user@example.com', 'hi')

    expect(result).toEqual(expect.objectContaining({ ok: false, notConfigured: true }))
    expect(connectSpy).not.toHaveBeenCalled()
    connectSpy.mockRestore()
  })

  it('rejects a blank destination without opening a socket', async () => {
    const connectSpy = jest.spyOn(net, 'connect')

    const provider = new EmailProvider({ host: '127.0.0.1', port: 1, from: 'me@example.com' })
    const result = await provider.send('   ', 'hi')

    expect(result).toEqual({ ok: false, reason: 'A recipient email address (destination) is required.' })
    expect(connectSpy).not.toHaveBeenCalled()
    connectSpy.mockRestore()
  })

  it('treats a whitespace-only host or from address as unconfigured', () => {
    expect(new EmailProvider({ host: '   ', from: 'me@example.com' }).isConfigured()).toBe(false)
    expect(new EmailProvider({ host: 'smtp.example.com', from: '  ' }).isConfigured()).toBe(false)
  })
})
