import { Agent as HttpAgent, createServer, Server } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { AddressInfo, Socket } from 'node:net'

import { SNSClient } from '@aws-sdk/client-sns'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { DomainEventInterface } from '@standardnotes/domain-events'

import { Env } from './Env'
import {
  buildSnsClientConfig,
  buildSnsDomainEventPublisher,
  CUSTOM_SNS_CONNECTION_TIMEOUT_MS,
  CUSTOM_SNS_REQUEST_TIMEOUT_MS,
  CUSTOM_SNS_SOCKET_TIMEOUT_MS,
} from './LazyDomainEventPublisher'

type ResolvedHandlerConfig = {
  connectionTimeout?: number
  requestTimeout?: number
  socketTimeout?: number
  throwOnRequestTimeout?: boolean
  httpAgentProvider: () => Promise<HttpAgent>
  httpsAgent?: HttpsAgent
}

const envWith = (values: Record<string, string>): Env =>
  ({
    get: (name: string) => values[name] ?? '',
  }) as Env

const resolvedHandlerConfig = async (handler: NodeHttpHandler): Promise<ResolvedHandlerConfig> =>
  await (
    handler as unknown as {
      configProvider: Promise<ResolvedHandlerConfig>
    }
  ).configProvider

const settleWithin = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SNS publishes did not settle')), timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })

describe('buildSnsClientConfig', () => {
  it('uses a bounded non-reused HTTP transport for a custom endpoint', async () => {
    const config = buildSnsClientConfig(
      envWith({
        SNS_AWS_REGION: 'us-east-1',
        SNS_ENDPOINT: 'http://floci:4566',
      }),
    )

    expect(config.endpoint).toBe('http://floci:4566')
    expect(config.maxAttempts).toBe(1)
    expect(config.requestHandler).toBeInstanceOf(NodeHttpHandler)

    const handlerConfig = await resolvedHandlerConfig(config.requestHandler as NodeHttpHandler)
    const agent = await handlerConfig.httpAgentProvider()

    expect(handlerConfig.connectionTimeout).toBe(CUSTOM_SNS_CONNECTION_TIMEOUT_MS)
    expect(handlerConfig.requestTimeout).toBe(CUSTOM_SNS_REQUEST_TIMEOUT_MS)
    expect(handlerConfig.socketTimeout).toBe(CUSTOM_SNS_SOCKET_TIMEOUT_MS)
    expect(handlerConfig.throwOnRequestTimeout).toBe(true)
    expect(agent).toBeInstanceOf(HttpAgent)
    expect(agent.keepAlive).toBe(false)
  })

  it('uses a non-reused HTTPS agent for a secure custom endpoint', async () => {
    const config = buildSnsClientConfig(
      envWith({
        SNS_AWS_REGION: 'us-east-1',
        SNS_ENDPOINT: 'https://sns.test.local',
      }),
    )

    const handlerConfig = await resolvedHandlerConfig(config.requestHandler as NodeHttpHandler)

    expect(handlerConfig.httpsAgent).toBeInstanceOf(HttpsAgent)
    expect(handlerConfig.httpsAgent?.keepAlive).toBe(false)
  })

  it('does not override the default AWS transport', () => {
    const config = buildSnsClientConfig(envWith({ SNS_AWS_REGION: 'eu-west-2' }))

    expect(config).toEqual({ region: 'eu-west-2' })
    expect(config.requestHandler).toBeUndefined()
  })

  it('settles two consecutive publishes against a FloCi-compatible HTTP responder', async () => {
    const sockets = new Set<Socket>()
    const requests: string[] = []
    const publishResponse = [
      '<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">',
      '<PublishResult><MessageId>00000000-0000-0000-0000-000000000001</MessageId></PublishResult>',
      '<ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000002</RequestId></ResponseMetadata>',
      '</PublishResponse>',
    ].join('')
    const server: Server = createServer((request, response) => {
      sockets.add(request.socket)
      request.setEncoding('utf8')
      let body = ''
      request.on('data', (chunk: string) => (body += chunk))
      request.on('end', () => {
        requests.push(body)
        response.writeHead(200, { 'Content-Type': 'text/xml' })
        response.end(publishResponse)
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const env = envWith({
      SNS_AWS_REGION: 'us-east-1',
      SNS_ENDPOINT: `http://127.0.0.1:${port}`,
      SNS_ACCESS_KEY_ID: 'test',
      SNS_SECRET_ACCESS_KEY: 'test',
    })
    const client = new SNSClient(buildSnsClientConfig(env))
    const publisher = buildSnsDomainEventPublisher(client, 'arn:aws:sns:us-east-1:000000000000:events', env)
    const event = {
      type: 'TEST_EVENT',
      payload: { value: true },
      meta: { origin: 'auth' },
    } as DomainEventInterface

    try {
      await expect(
        settleWithin(
          (async () => {
            await publisher.publish(event)
            await publisher.publish(event)
          })(),
          2_000,
        ),
      ).resolves.toBeUndefined()

      expect(requests).toHaveLength(2)
      expect(sockets.size).toBe(2)
    } finally {
      client.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        }),
      )
    }
  })

  it('passes a publish deadline only when a custom endpoint is configured', async () => {
    const event = {
      type: 'TEST_EVENT',
      payload: { value: true },
      meta: { origin: 'auth' },
    } as DomainEventInterface
    const topicArn = 'arn:aws:sns:us-east-1:000000000000:events'
    const customSend = jest.fn(async (..._args: unknown[]) => ({}))
    const customPublisher = buildSnsDomainEventPublisher(
      { send: customSend } as unknown as SNSClient,
      topicArn,
      envWith({ SNS_ENDPOINT: 'http://floci:4566' }),
    )
    const awsSend = jest.fn(async (..._args: unknown[]) => ({}))
    const awsPublisher = buildSnsDomainEventPublisher(
      { send: awsSend } as unknown as SNSClient,
      topicArn,
      envWith({ SNS_AWS_REGION: 'eu-west-2' }),
    )

    await customPublisher.publish(event)
    await awsPublisher.publish(event)

    expect(customPublisher).toHaveProperty('publishTimeoutMs', CUSTOM_SNS_REQUEST_TIMEOUT_MS)
    expect(customSend.mock.calls[0]).toHaveLength(2)
    expect((customSend.mock.calls[0][1] as { abortSignal?: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal)
    expect(awsPublisher).toHaveProperty('publishTimeoutMs', undefined)
    expect(awsSend.mock.calls[0]).toHaveLength(1)
  })
})
