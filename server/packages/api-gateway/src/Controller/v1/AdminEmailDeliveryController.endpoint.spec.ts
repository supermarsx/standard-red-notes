import 'reflect-metadata'

import { RoleName } from '@standardnotes/domain-core'
import express, { RequestHandler } from 'express'
import { AddressInfo } from 'node:net'
import { Server } from 'node:http'

import {
  AdminEmailDeliveryService,
  AdminEmailDeliveryServiceError,
  EmailDeliveryLogRecord,
  EmailQueueRecord,
  EmailRelaySnapshot,
} from '../../Service/EmailDelivery/AdminEmailDeliveryService'
import { createAdminEmailDeliveryRouter } from './createAdminEmailDeliveryRouter'

type ApiResponse = { status: number; headers: Headers; body?: unknown; text: string }

const storedSnapshot: EmailRelaySnapshot = {
  relays: [
    {
      id: 'smtp-primary',
      name: 'Primary SMTP',
      kind: 'smtp',
      enabled: true,
      priority: 1,
      from: 'Notes <notes@example.com>',
      rateLimit: { max: 100, windowSeconds: 60 },
      host: 'smtp.example.com',
      port: 587,
      username: 'mailer',
      tlsMode: 'starttls',
      credentialsConfigured: true,
      password: 'must-never-leave-the-service',
    },
  ],
  fallbackPolicy: { mode: 'next-enabled' },
  configured: true,
}

const queueRecord: EmailQueueRecord = {
  id: 'job-1',
  state: 'dead',
  source: 'published-reminder',
  attempt: 3,
  maxAttempts: 3,
  createdAt: Date.UTC(2026, 7, 13, 10, 0, 0),
  nextAttemptAt: Date.UTC(2026, 7, 13, 10, 5, 0),
  lastRelayId: 'smtp-primary',
  lastFailureClass: 'authentication',
  recipient: 'queue-private@example.com',
  subject: 'private subject',
  body: 'private body',
  attachments: [{ filename: 'private.pdf' }],
  rawProviderResponse: '550 private upstream response',
}

const logRecord: EmailDeliveryLogRecord = {
  id: 'log-1',
  jobId: 'job-1',
  relayId: 'smtp-primary',
  relayKind: 'smtp',
  attempt: 3,
  outcome: 'rejected',
  failureClass: 'authentication',
  providerCode: 'AUTH',
  httpStatus: 401,
  durationMs: 42,
  createdAt: Date.UTC(2026, 7, 13, 10, 1, 0),
  recipient: 'log-private@example.com',
  subject: 'private subject',
  body: 'private body',
  attachments: [{ filename: 'private.pdf' }],
  rawProviderResponse: '<html>private upstream response</html>',
}

describe('admin email delivery HTTP boundary', () => {
  let service: jest.Mocked<AdminEmailDeliveryService>

  const authenticationMiddleware: RequestHandler = (request, response, next) => {
    const identity = request.header('x-test-identity')
    if (identity === 'admin') {
      response.locals.user = { uuid: 'admin-1' }
      response.locals.roles = [{ name: RoleName.NAMES.AdminUser }]
    } else if (identity === 'user') {
      response.locals.user = { uuid: 'user-1' }
      response.locals.roles = []
    }
    next()
  }

  const call = async (
    path: string,
    init: RequestInit = {},
    options: { identity?: 'admin' | 'user' | 'none'; wiredService?: AdminEmailDeliveryService } = {},
  ): Promise<ApiResponse> => {
    const app = express()
    app.use(express.json({ limit: '64kb' }))
    app.use(
      '/v1/admin/email-delivery',
      createAdminEmailDeliveryRouter(options.wiredService === undefined ? service : options.wiredService, {
        authenticationMiddleware,
        mountTestRoute: true,
      }),
    )
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    const address = server.address() as AddressInfo
    const headers = new Headers(init.headers)
    const identity = options.identity ?? 'admin'
    if (identity !== 'none') {
      headers.set('x-test-identity', identity)
    }
    if (init.body !== undefined) {
      headers.set('content-type', 'application/json')
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/admin/email-delivery${path}`, {
        ...init,
        headers,
      })
      const text = await response.text()
      let body: unknown
      if (text.length > 0) {
        try {
          body = JSON.parse(text)
        } catch {
          body = undefined
        }
      }
      return { status: response.status, headers: response.headers, body, text }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }

  beforeEach(() => {
    service = {
      getRelays: jest.fn().mockResolvedValue(storedSnapshot),
      putRelays: jest.fn().mockResolvedValue(storedSnapshot),
      testDelivery: jest.fn().mockResolvedValue({
        accepted: true,
        relayId: 'smtp-primary',
        relayKind: 'smtp',
        outcome: 'sent',
      }),
      listQueue: jest.fn().mockResolvedValue({ items: [queueRecord] }),
      listLogs: jest.fn().mockResolvedValue({ items: [logRecord] }),
      retryQueueItem: jest.fn().mockResolvedValue(queueRecord),
      discardQueueItem: jest.fn().mockResolvedValue(undefined),
    }
  })

  it('returns 401 without an authenticated identity and 403 for an authenticated non-admin', async () => {
    const unauthenticated = await call('/relays', {}, { identity: 'none' })
    const forbidden = await call('/relays', {}, { identity: 'user' })

    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.body).toEqual({ error: { message: 'Authentication required.' } })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body).toEqual({ error: { message: 'Admin role required.' } })
    expect(service.getRelays).not.toHaveBeenCalled()
  })

  it('GET /relays projects an exact public DTO without returning stored credentials', async () => {
    ;(storedSnapshot.relays[0] as unknown as Record<string, unknown>).recipient = 'private@example.com'
    ;(storedSnapshot.relays[0] as unknown as Record<string, unknown>).rawProviderResponse = 'private upstream body'

    const response = await call('/relays')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      relays: [
        {
          id: 'smtp-primary',
          name: 'Primary SMTP',
          kind: 'smtp',
          enabled: true,
          priority: 1,
          from: 'Notes <notes@example.com>',
          rateLimit: { max: 100, windowSeconds: 60 },
          host: 'smtp.example.com',
          port: 587,
          username: 'mailer',
          tlsMode: 'starttls',
          credentialsConfigured: true,
        },
      ],
      fallbackPolicy: { mode: 'next-enabled' },
      configured: true,
    })
    expect(response.text).not.toContain('must-never-leave-the-service')
    expect(response.text).not.toContain('private@example.com')
    expect(response.text).not.toContain('private upstream body')
  })

  it('PUT /relays accepts write-only secrets but re-projects the service response', async () => {
    const update = {
      relays: [
        {
          id: 'smtp-primary',
          name: 'Primary SMTP',
          kind: 'smtp',
          enabled: true,
          priority: 1,
          from: 'Notes <notes@example.com>',
          rateLimit: { max: 100, windowSeconds: 60 },
          host: 'smtp.example.com',
          port: 587,
          username: 'mailer',
          password: 'new-write-only-secret',
          tlsMode: 'starttls',
        },
      ],
      fallbackPolicy: { mode: 'next-enabled' },
    }

    const response = await call('/relays', { method: 'PUT', body: JSON.stringify(update) })

    expect(response.status).toBe(200)
    expect(service.putRelays).toHaveBeenCalledWith(update)
    expect(response.text).not.toContain('new-write-only-secret')
    expect(response.text).not.toContain('must-never-leave-the-service')
  })

  it.each([
    [
      'an unknown relay field',
      {
        relays: [
          {
            id: 'sg-primary',
            name: 'SendGrid',
            kind: 'sendgrid',
            enabled: true,
            priority: 1,
            from: 'notes@example.com',
            rateLimit: { max: 100, windowSeconds: 60 },
            apiKey: 'secret',
            credentialsConfigured: true,
          },
        ],
        fallbackPolicy: { mode: 'none' },
      },
    ],
    [
      'duplicate priorities',
      {
        relays: [
          {
            id: 'sg-primary',
            name: 'SendGrid',
            kind: 'sendgrid',
            enabled: true,
            priority: 1,
            from: 'notes@example.com',
            rateLimit: { max: 100, windowSeconds: 60 },
          },
          {
            id: 'mg-secondary',
            name: 'Mailgun',
            kind: 'mailgun',
            enabled: true,
            priority: 1,
            from: 'notes@example.com',
            rateLimit: { max: 100, windowSeconds: 60 },
            domain: 'mg.example.com',
          },
        ],
        fallbackPolicy: { mode: 'next-enabled' },
      },
    ],
  ])('PUT /relays rejects %s with 400 before calling persistence', async (_label, body) => {
    const response = await call('/relays', { method: 'PUT', body: JSON.stringify(body) })

    expect(response.status).toBe(400)
    expect(service.putRelays).not.toHaveBeenCalled()
  })

  it('POST /test validates its exact body and returns only the redacted test result', async () => {
    service.testDelivery.mockResolvedValue({
      accepted: false,
      relayId: 'smtp-primary',
      relayKind: 'smtp',
      outcome: 'rejected',
      recipient: 'private@example.com',
      rawProviderResponse: '550 private provider response',
    })

    const invalid = await call('/test', {
      method: 'POST',
      body: JSON.stringify({ recipient: 'not-an-email', rawProviderResponse: 'injected' }),
    })
    const response = await call('/test', {
      method: 'POST',
      body: JSON.stringify({ recipient: 'operator@example.com', relayId: 'smtp-primary' }),
    })

    expect(invalid.status).toBe(400)
    expect(response.status).toBe(200)
    expect(service.testDelivery).toHaveBeenCalledWith({
      recipient: 'operator@example.com',
      relayId: 'smtp-primary',
    })
    expect(response.body).toEqual({
      accepted: false,
      relayId: 'smtp-primary',
      relayKind: 'smtp',
      outcome: 'rejected',
    })
    expect(response.text).not.toContain('private@example.com')
    expect(response.text).not.toContain('550 private provider response')
  })

  it('GET /queue validates filters, maps epoch milliseconds to ISO, and drops all content fields', async () => {
    const invalid = await call('/queue?state=dead&state=ready&limit=101')
    const response = await call('/queue?state=dead&limit=25&cursor=opaque%2Bcursor%3D')

    expect(invalid.status).toBe(400)
    expect(response.status).toBe(200)
    expect(service.listQueue).toHaveBeenCalledWith({ state: 'dead', limit: 25, cursor: 'opaque+cursor=' })
    expect(response.body).toEqual({
      items: [
        {
          id: 'job-1',
          state: 'dead',
          source: 'published-reminder',
          attempt: 3,
          maxAttempts: 3,
          createdAt: '2026-08-13T10:00:00.000Z',
          nextAttemptAt: '2026-08-13T10:05:00.000Z',
          lastRelayId: 'smtp-primary',
          lastFailureClass: 'authentication',
        },
      ],
    })
    expect(response.text).not.toContain('queue-private@example.com')
    expect(response.text).not.toContain('private subject')
    expect(response.text).not.toContain('private body')
    expect(response.text).not.toContain('private.pdf')
    expect(response.text).not.toContain('550 private upstream response')
  })

  it('GET /logs validates filters, maps epoch milliseconds to ISO, and emits redacted codes only', async () => {
    const invalid = await call('/logs?outcome=everything')
    const response = await call('/logs?limit=20&relayId=smtp-primary&outcome=rejected&cursor=page-2')

    expect(invalid.status).toBe(400)
    expect(response.status).toBe(200)
    expect(service.listLogs).toHaveBeenCalledWith({
      limit: 20,
      relayId: 'smtp-primary',
      outcome: 'rejected',
      cursor: 'page-2',
    })
    expect(response.body).toEqual({
      items: [
        {
          id: 'log-1',
          jobId: 'job-1',
          relayId: 'smtp-primary',
          relayKind: 'smtp',
          attempt: 3,
          outcome: 'rejected',
          failureClass: 'authentication',
          providerCode: 'AUTH',
          httpStatus: 401,
          durationMs: 42,
          createdAt: '2026-08-13T10:01:00.000Z',
        },
      ],
    })
    expect(response.text).not.toContain('log-private@example.com')
    expect(response.text).not.toContain('private subject')
    expect(response.text).not.toContain('private body')
    expect(response.text).not.toContain('private.pdf')
    expect(response.text).not.toContain('private upstream response')
  })

  it('POST retry returns 202 and DELETE discard returns an empty 204', async () => {
    const retried = await call('/queue/job-1/retry', { method: 'POST', body: '{}' })
    const discarded = await call('/queue/job-1', { method: 'DELETE' })

    expect(retried.status).toBe(202)
    expect((retried.body as { createdAt: string }).createdAt).toBe('2026-08-13T10:00:00.000Z')
    expect(service.retryQueueItem).toHaveBeenCalledWith('job-1')
    expect(discarded.status).toBe(204)
    expect(discarded.text).toBe('')
    expect(service.discardQueueItem).toHaveBeenCalledWith('job-1')
  })

  it.each([
    ['/queue/job%2Fchild/retry', 'POST'],
    ['/queue/job%5Cchild/retry', 'POST'],
    ['/queue/%2e%2e%2Fjob/retry', 'POST'],
    [`/queue/${'a'.repeat(129)}/retry`, 'POST'],
    ['/queue/job%2Fchild', 'DELETE'],
    ['/queue/job%5Cchild', 'DELETE'],
    ['/queue/%2e%2e%2Fjob', 'DELETE'],
    [`/queue/${'a'.repeat(129)}`, 'DELETE'],
  ])('rejects unsafe or oversized queue identifiers on %s', async (path, method) => {
    const response = await call(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) })

    expect(response.status).toBe(400)
    expect(service.retryQueueItem).not.toHaveBeenCalled()
    expect(service.discardQueueItem).not.toHaveBeenCalled()
  })

  it.each([
    ['bad-request', 400],
    ['not-found', 404],
    ['conflict', 409],
    ['rate-limited', 429],
    ['provider-failure', 502],
    ['unavailable', 503],
  ] as const)('maps the %s service classification to HTTP %i without exposing its Error text', async (code, status) => {
    service.retryQueueItem.mockRejectedValue(
      new AdminEmailDeliveryServiceError(code, code === 'rate-limited' ? 30 : undefined),
    )

    const response = await call('/queue/job-1/retry', { method: 'POST', body: '{}' })

    expect(response.status).toBe(status)
    expect(response.text).not.toContain(`Admin email delivery service error: ${code}`)
    if (code === 'rate-limited') {
      expect(response.headers.get('retry-after')).toBe('30')
    }
  })

  it('returns 501 when the advanced subsystem is not supported by this topology', async () => {
    const response = await call('/relays', {}, { wiredService: undefined })

    expect(response.status).toBe(200)

    const app = express()
    app.use('/v1/admin/email-delivery', createAdminEmailDeliveryRouter(undefined, { authenticationMiddleware }))
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    const address = server.address() as AddressInfo
    try {
      const unavailable = await fetch(`http://127.0.0.1:${address.port}/v1/admin/email-delivery/relays`, {
        headers: { 'x-test-identity': 'admin' },
      })
      expect(unavailable.status).toBe(501)
      expect(await unavailable.json()).toEqual({
        error: { message: 'Advanced email delivery is not available in this topology.' },
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
})
