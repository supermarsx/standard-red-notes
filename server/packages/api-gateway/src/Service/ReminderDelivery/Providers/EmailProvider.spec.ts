import * as net from 'net'

import { EmailProvider, SmtpConfig, smtpTransportOptions } from './EmailProvider'

const CRLF = '\r\n'

type SmtpReply = string | null | undefined

interface FakeSmtp {
  port: number
  received: string[]
  close(): Promise<void>
}

const startFakeSmtp = async (
  script: (line: string, sent: string[]) => SmtpReply,
  greeting: string | null = '220 fake ESMTP ready',
): Promise<FakeSmtp> => {
  const received: string[] = []
  const sockets: net.Socket[] = []

  const writeReply = (socket: net.Socket, reply: string): void => {
    socket.write(reply + CRLF)
  }

  const server = net.createServer((socket) => {
    sockets.push(socket)
    let inData = false
    let buffer = ''
    socket.setEncoding('utf8')
    if (greeting !== null) {
      writeReply(socket, greeting)
    }
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
        if (reply !== undefined) {
          writeReply(socket, reply)
        }
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
        for (const socket of sockets) {
          socket.destroy()
        }
        server.close(() => resolve())
      }),
  }
}

const defaultScript = (line: string): SmtpReply => {
  const verb = line.toUpperCase()
  if (verb.startsWith('EHLO')) {
    // The continuation and terminating lines deliberately arrive in one write.
    return '250-fake greets you\r\n250 8BITMIME'
  }
  if (verb.startsWith('STARTTLS')) {
    return '454 TLS is not available'
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
  jest.setTimeout(30_000)

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

  it('handles a multiline SMTP reply and relays through an explicitly trusted plaintext server', async () => {
    const smtp = await start(defaultScript)
    const provider = new EmailProvider({
      host: '127.0.0.1',
      port: smtp.port,
      from: 'Reminders <reminders@example.com>',
      allowInsecure: true,
    })

    const result = await provider.send('user@example.com', 'Water the plants')

    expect(result).toEqual({ ok: true })
    expect(smtp.received).toEqual(
      expect.arrayContaining([
        'EHLO standard-red-notes',
        'MAIL FROM:<reminders@example.com>',
        'RCPT TO:<user@example.com>',
        'DATA',
        'To: user@example.com',
        'Subject: Reminder',
        'Water the plants',
        '.',
      ]),
    )
  })

  it('requires STARTTLS by default instead of silently sending plaintext', async () => {
    const smtp = await start(defaultScript)
    const provider = new EmailProvider({
      host: '127.0.0.1',
      port: smtp.port,
      from: 'me@example.com',
      user: 'smtp-user',
      password: 'smtp-password',
    })

    const result = await provider.send('user@example.com', 'hi')

    expect(result.ok).toBe(false)
    expect(smtp.received).toContain('STARTTLS')
    expect(smtp.received).not.toContain('MAIL FROM:<me@example.com>')
    expect(smtp.received).not.toContain(Buffer.from('smtp-user').toString('base64'))
  })

  it('pins TLS policy and bounded connect, greeting, and socket timeouts in the transport options', () => {
    expect(
      smtpTransportOptions({ host: 'smtp.example.com', from: 'me@example.com', user: 'user', password: 'pass' }),
    ).toEqual(
      expect.objectContaining({
        secure: false,
        requireTLS: true,
        ignoreTLS: false,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      }),
    )
    expect(
      smtpTransportOptions({
        host: 'localhost',
        from: 'me@example.com',
        allowInsecure: true,
        connectionTimeoutMs: 500_000,
        greetingTimeoutMs: 0,
        socketTimeoutMs: 25,
      }),
    ).toEqual(
      expect.objectContaining({
        requireTLS: false,
        ignoreTLS: true,
        connectionTimeout: 120_000,
        greetingTimeout: 10_000,
        socketTimeout: 25,
      }),
    )
    expect(smtpTransportOptions({ host: 'smtp.example.com', from: 'me@example.com', secure: true })).toEqual(
      expect.objectContaining({ port: 465, secure: true, requireTLS: false, ignoreTLS: false }),
    )
  })

  it('dot-stuffs body lines that begin with a period', async () => {
    const smtp = await start(defaultScript)
    const provider = new EmailProvider({
      host: '127.0.0.1',
      port: smtp.port,
      from: 'me@example.com',
      allowInsecure: true,
    })

    const result = await provider.send('user@example.com', '.hidden\n.. already stuffed')

    expect(result).toEqual({ ok: true })
    expect(smtp.received).toEqual(expect.arrayContaining(['..hidden', '... already stuffed']))
    expect(smtp.received.filter((line) => line === '.')).toHaveLength(1)
  })

  it('authenticates only after an explicit plaintext opt-out on an internal relay', async () => {
    const encodedUser = Buffer.from('smtp-user').toString('base64')
    const encodedPassword = Buffer.from('s3cr3t').toString('base64')
    const smtp = await start((line) => {
      if (line.toUpperCase().startsWith('EHLO')) {
        return '250-fake greets you\r\n250 AUTH LOGIN'
      }
      if (line.toUpperCase() === 'AUTH LOGIN') {
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
      allowInsecure: true,
    })

    const result = await provider.send('user@example.com', 'hi')

    expect(result).toEqual({ ok: true })
    expect(smtp.received).toEqual(expect.arrayContaining(['AUTH LOGIN', encodedUser, encodedPassword]))
    expect(smtp.received).not.toContain('s3cr3t')
  })

  it('treats partial credentials and invalid ports as invalid configuration', () => {
    expect(new EmailProvider({ host: 'smtp.example.com', from: 'me@example.com', user: 'user' }).isConfigured()).toBe(
      false,
    )
    expect(
      new EmailProvider({ host: 'smtp.example.com', from: 'me@example.com', password: 'secret' }).isConfigured(),
    ).toBe(false)
    expect(new EmailProvider({ host: 'smtp.example.com', from: 'me@example.com', port: 70_000 }).isConfigured()).toBe(
      false,
    )
  })

  it('limits the plaintext override to literal loopback/private IPs and localhost names', () => {
    expect(
      new EmailProvider({ host: 'smtp.example.com', from: 'me@example.com', allowInsecure: true }).isConfigured(),
    ).toBe(false)
    expect(new EmailProvider({ host: 'mail-relay', from: 'me@example.com', allowInsecure: true }).isConfigured()).toBe(
      false,
    )
    expect(
      new EmailProvider({ host: '192.168.20.5', from: 'me@example.com', allowInsecure: true }).isConfigured(),
    ).toBe(true)
    expect(new EmailProvider({ host: '::1', from: 'me@example.com', allowInsecure: true }).isConfigured()).toBe(true)
    expect(
      new EmailProvider({ host: 'smtp.localhost', from: 'me@example.com', allowInsecure: true }).isConfigured(),
    ).toBe(true)
  })

  it('re-resolves the runtime overlay for every send', async () => {
    const smtp = await start(defaultScript)
    let config: SmtpConfig = { host: '', from: '', tlsMode: 'starttls' }
    const resolveConfig = jest.fn(async () => config)
    const provider = new EmailProvider(resolveConfig)

    await expect(provider.send('user@example.com', 'first')).resolves.toEqual(
      expect.objectContaining({ ok: false, notConfigured: true }),
    )

    config = {
      host: '127.0.0.1',
      port: smtp.port,
      from: 'notes@example.com',
      tlsMode: 'insecure' as const,
    }
    await expect(provider.send('user@example.com', 'second')).resolves.toEqual({ ok: true })
    expect(resolveConfig).toHaveBeenCalledTimes(2)
    expect(smtp.received).toContain('second')
  })

  it('rejects recipient and sender CRLF injection without opening a socket', async () => {
    const connectSpy = jest.spyOn(net, 'connect')
    const provider = new EmailProvider({ host: 'smtp.example.com', from: 'me@example.com' })

    const recipientResult = await provider.send('user@example.com\r\nBcc: attacker@example.com', 'hi')
    const senderResult = await new EmailProvider({
      host: 'smtp.example.com',
      from: 'me@example.com\r\nBcc: attacker@example.com',
    }).send('user@example.com', 'hi')

    expect(recipientResult).toEqual({
      ok: false,
      reason: 'The recipient email address contains invalid line breaks.',
    })
    expect(senderResult).toEqual(expect.objectContaining({ ok: false, notConfigured: true }))
    expect(connectSpy).not.toHaveBeenCalled()
    connectSpy.mockRestore()
  })

  it('fails promptly when the server closes mid-conversation', async () => {
    const smtp = await start((line) => {
      return line.toUpperCase().startsWith('RCPT TO') ? null : defaultScript(line)
    })
    const provider = new EmailProvider({
      host: '127.0.0.1',
      port: smtp.port,
      from: 'me@example.com',
      allowInsecure: true,
      socketTimeoutMs: 100,
    })

    const result = await provider.send('user@example.com', 'hi')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/^Email delivery failed/)
    expect(smtp.received).not.toContain('DATA')
  })

  it('bounds a missing server greeting', async () => {
    const smtp = await start(defaultScript, null)
    const provider = new EmailProvider({
      host: '127.0.0.1',
      port: smtp.port,
      from: 'me@example.com',
      allowInsecure: true,
      greetingTimeoutMs: 50,
    })

    const result = await provider.send('user@example.com', 'hi')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('ETIMEDOUT')
  })

  it('bounds a socket that stops replying mid-conversation', async () => {
    const smtp = await start((line) => {
      return line.toUpperCase().startsWith('MAIL FROM') ? undefined : defaultScript(line)
    })
    const provider = new EmailProvider({
      host: '127.0.0.1',
      port: smtp.port,
      from: 'me@example.com',
      allowInsecure: true,
      socketTimeoutMs: 50,
    })

    const result = await provider.send('user@example.com', 'hi')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('ETIMEDOUT')
  })

  it('does not expose a credential echoed in an SMTP rejection', async () => {
    const smtp = await start((line) => {
      if (line.toUpperCase().startsWith('EHLO')) {
        return '250-fake greets you\r\n250 AUTH LOGIN'
      }
      if (line.toUpperCase() === 'AUTH LOGIN') {
        return '535 password s3cr3t rejected'
      }
      return defaultScript(line)
    })
    const provider = new EmailProvider({
      host: '127.0.0.1',
      port: smtp.port,
      from: 'me@example.com',
      user: 'smtp-user',
      password: 's3cr3t',
      allowInsecure: true,
    })

    const result = await provider.send('user@example.com', 'hi')

    expect(result.ok).toBe(false)
    expect(result.reason).not.toContain('s3cr3t')
    expect(result.reason?.length).toBeLessThan(100)
  })

  it('reports a bounded transport failure when nothing is listening', async () => {
    const smtp = await startFakeSmtp(defaultScript)
    const deadPort = smtp.port
    await smtp.close()
    const provider = new EmailProvider({
      host: '127.0.0.1',
      port: deadPort,
      from: 'me@example.com',
      allowInsecure: true,
      connectionTimeoutMs: 100,
    })

    const result = await provider.send('user@example.com', 'hi')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/^Email delivery failed/)
    expect(result.reason?.length).toBeLessThan(100)
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
})
