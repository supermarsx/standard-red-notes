import { describe, it, expect, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { mintConnectionToken, verifyConnectionToken } from '../src/auth.js'
import { ConnectionRegistry, parseDispatchMessage, type Conn, type SendableSocket } from '../src/registry.js'
import { handleRawMessage, type Logger } from '../src/redisBridge.js'

const SECRET = 'test-secret'

/** A fake socket whose `.send` is a spy. */
function fakeSocket(): { socket: SendableSocket; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  return { socket: { send }, send }
}

function conn(sessionUuid: string, socket: SendableSocket): Conn {
  return { socket, userUuid: `user-${sessionUuid}`, sessionUuid, connectionId: `conn-${sessionUuid}` }
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

describe('auth: verifyConnectionToken', () => {
  it('accepts a freshly-signed HS256 token', () => {
    const token = jwt.sign({ userUuid: 'u1', sessionUuid: 's1' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '60s',
    })
    const payload = verifyConnectionToken(token, SECRET)
    expect(payload.userUuid).toBe('u1')
    expect(payload.sessionUuid).toBe('s1')
  })

  it('accepts a token minted via mintConnectionToken', () => {
    const token = mintConnectionToken({ userUuid: 'u9', sessionUuid: 's9' }, SECRET, '60s')
    const payload = verifyConnectionToken(token, SECRET)
    expect(payload.userUuid).toBe('u9')
    expect(payload.sessionUuid).toBe('s9')
  })

  it('rejects a token signed with a different secret', () => {
    const token = jwt.sign({ userUuid: 'u1', sessionUuid: 's1' }, 'wrong-secret', {
      algorithm: 'HS256',
    })
    expect(() => verifyConnectionToken(token, SECRET)).toThrow()
  })

  it('rejects a garbage token', () => {
    expect(() => verifyConnectionToken('not-a-jwt', SECRET)).toThrow()
  })

  it('rejects a non-HS256 (alg=none) token', () => {
    const token = jwt.sign({ userUuid: 'u1', sessionUuid: 's1' }, '', { algorithm: 'none' })
    expect(() => verifyConnectionToken(token, SECRET)).toThrow()
  })

  it('rejects a token missing userUuid', () => {
    const token = jwt.sign({ sessionUuid: 's1' }, SECRET, { algorithm: 'HS256' })
    expect(() => verifyConnectionToken(token, SECRET)).toThrow()
  })
})

describe('registry: add/remove + pushToUser exclusion', () => {
  it('adds and removes connections', () => {
    const reg = new ConnectionRegistry()
    const a = fakeSocket()
    const c = conn('s1', a.socket)
    reg.add('u1', c)
    expect(reg.size()).toBe(1)
    expect(reg.get('u1')).toHaveLength(1)
    reg.remove('u1', c)
    expect(reg.size()).toBe(0)
    expect(reg.get('u1')).toHaveLength(0)
  })

  it('pushes to all of a user\'s sockets', () => {
    const reg = new ConnectionRegistry()
    const a = fakeSocket()
    const b = fakeSocket()
    reg.add('u1', conn('s1', a.socket))
    reg.add('u1', conn('s2', b.socket))
    const sent = reg.pushToUser('u1', 'hello')
    expect(sent).toBe(2)
    expect(a.send).toHaveBeenCalledWith('hello')
    expect(b.send).toHaveBeenCalledWith('hello')
  })

  it('excludes the originating session', () => {
    const reg = new ConnectionRegistry()
    const origin = fakeSocket()
    const other = fakeSocket()
    reg.add('u1', conn('s1', origin.socket))
    reg.add('u1', conn('s2', other.socket))
    const sent = reg.pushToUser('u1', 'payload', 's1')
    expect(sent).toBe(1)
    expect(origin.send).not.toHaveBeenCalled()
    expect(other.send).toHaveBeenCalledWith('payload')
  })

  it('does not push to other users', () => {
    const reg = new ConnectionRegistry()
    const mine = fakeSocket()
    const theirs = fakeSocket()
    reg.add('u1', conn('s1', mine.socket))
    reg.add('u2', conn('s2', theirs.socket))
    reg.pushToUser('u1', 'x')
    expect(mine.send).toHaveBeenCalledWith('x')
    expect(theirs.send).not.toHaveBeenCalled()
  })
})

describe('parseDispatchMessage', () => {
  it('parses a well-formed payload', () => {
    const parsed = parseDispatchMessage(
      JSON.stringify({ userUuid: 'u1', message: '{"type":"X"}', originatingSessionUuid: 's1' }),
    )
    expect(parsed.userUuid).toBe('u1')
    expect(parsed.message).toBe('{"type":"X"}')
    expect(parsed.originatingSessionUuid).toBe('s1')
  })

  it('throws on malformed json', () => {
    expect(() => parseDispatchMessage('{')).toThrow()
  })

  it('throws when userUuid is missing', () => {
    expect(() => parseDispatchMessage(JSON.stringify({ message: 'm' }))).toThrow()
  })
})

describe('redis dispatch: handleRawMessage', () => {
  it('routes a raw message to the matching user, excluding origin session', () => {
    const reg = new ConnectionRegistry()
    const origin = fakeSocket()
    const other = fakeSocket()
    const elsewhere = fakeSocket()
    reg.add('u1', conn('s1', origin.socket))
    reg.add('u1', conn('s2', other.socket))
    reg.add('u2', conn('s3', elsewhere.socket))

    const rawMessage = '{"type":"ITEMS_CHANGED_ON_SERVER","payload":{}}'
    const sent = handleRawMessage(
      reg,
      JSON.stringify({ userUuid: 'u1', message: rawMessage, originatingSessionUuid: 's1' }),
      silentLogger,
    )

    expect(sent).toBe(1)
    // Raw message forwarded verbatim (not re-wrapped).
    expect(other.send).toHaveBeenCalledWith(rawMessage)
    expect(origin.send).not.toHaveBeenCalled()
    expect(elsewhere.send).not.toHaveBeenCalled()
  })

  it('forwards to all sessions when no originatingSessionUuid', () => {
    const reg = new ConnectionRegistry()
    const a = fakeSocket()
    const b = fakeSocket()
    reg.add('u1', conn('s1', a.socket))
    reg.add('u1', conn('s2', b.socket))

    const sent = handleRawMessage(
      reg,
      JSON.stringify({ userUuid: 'u1', message: 'm' }),
      silentLogger,
    )
    expect(sent).toBe(2)
  })

  it('drops malformed messages without throwing', () => {
    const reg = new ConnectionRegistry()
    const warn = vi.fn()
    const sent = handleRawMessage(reg, 'not-json', { ...silentLogger, warn })
    expect(sent).toBe(0)
    expect(warn).toHaveBeenCalled()
  })
})
