import { createServer, Server } from 'node:http'
import { AddressInfo, Socket } from 'node:net'

import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { DomainEventInterface } from '@standardnotes/domain-events'

import { SNSDomainEventPublisher, SNSPublishTimeoutError } from './SNSDomainEventPublisher'

const event = {
  type: 'USER_REGISTERED',
  payload: { userUuid: 'user-uuid' },
  meta: { origin: 'auth' },
} as DomainEventInterface
const targetedEvent = {
  type: 'USER_REGISTERED',
  payload: { userUuid: 'user-uuid' },
  meta: { origin: 'auth', target: 'syncing-server' },
} as DomainEventInterface
const topicArn = 'arn:aws:sns:us-east-1:000000000000:events'

const settleWithin = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SNS publish did not settle')), timeoutMs)

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

const closeServer = async (server: Server): Promise<void> => {
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

describe('SNSDomainEventPublisher', () => {
  it('preserves the default SDK send behavior when no deadline is configured', async () => {
    const send = jest.fn(async (..._args: unknown[]) => ({}))
    const publisher = new SNSDomainEventPublisher({ send } as unknown as SNSClient, topicArn)

    await publisher.publish(event)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]).toHaveLength(1)
  })

  it('adds a target message attribute when the event declares one', async () => {
    const send = jest.fn(async (..._args: unknown[]) => ({}))
    const publisher = new SNSDomainEventPublisher({ send } as unknown as SNSClient, topicArn)

    await publisher.publish(targetedEvent)

    const { input } = send.mock.calls[0][0] as PublishCommand
    expect(input.MessageAttributes?.target).toEqual({
      DataType: 'String',
      StringValue: 'syncing-server',
    })
  })

  it('omits the target message attribute when the event declares none', async () => {
    const send = jest.fn(async (..._args: unknown[]) => ({}))
    const publisher = new SNSDomainEventPublisher({ send } as unknown as SNSClient, topicArn)

    await publisher.publish(event)

    const { input } = send.mock.calls[0][0] as PublishCommand
    expect(input.MessageAttributes).not.toHaveProperty('target')
  })

  it('rethrows a non-abort failure untouched and still clears the deadline', async () => {
    const failure = new Error('SNS is unreachable')
    let abortSignal: AbortSignal | undefined
    const send = jest.fn(async (...args: unknown[]) => {
      abortSignal = (args[1] as { abortSignal?: AbortSignal } | undefined)?.abortSignal

      throw failure
    })
    const publisher = new SNSDomainEventPublisher({ send } as unknown as SNSClient, topicArn, 10)

    await expect(publisher.publish(event)).rejects.toBe(failure)

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(abortSignal?.aborted).toBe(false)
  })

  it('clears the deadline after a successful publish', async () => {
    let abortSignal: AbortSignal | undefined
    const send = jest.fn(async (...args: unknown[]) => {
      abortSignal = (args[1] as { abortSignal?: AbortSignal } | undefined)?.abortSignal

      return {}
    })
    const publisher = new SNSDomainEventPublisher({ send } as unknown as SNSClient, topicArn, 10)

    await publisher.publish(event)
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(abortSignal).toBeDefined()
    expect(abortSignal?.aborted).toBe(false)
  })

  it('aborts a valid response whose body stream never ends without retrying', async () => {
    const sockets = new Set<Socket>()
    let requestCount = 0
    const publishResponse = [
      '<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">',
      '<PublishResult><MessageId>00000000-0000-0000-0000-000000000001</MessageId></PublishResult>',
      '<ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000002</RequestId></ResponseMetadata>',
      '</PublishResponse>',
    ].join('')
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        requestCount += 1
        response.writeHead(200, {
          'Content-Type': 'text/xml; charset=utf-8',
          'Transfer-Encoding': 'chunked',
        })
        response.write(publishResponse)
      })
    })
    server.on('connection', (socket) => sockets.add(socket))

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const client = new SNSClient({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    })
    const publisher = new SNSDomainEventPublisher(client, topicArn, 100)

    try {
      await expect(settleWithin(publisher.publish(event), 1_000)).rejects.toMatchObject({
        name: SNSPublishTimeoutError.name,
        message: 'SNS publish timed out after 100 ms.',
      })
      expect(requestCount).toBe(1)

      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(sockets.size).toBe(1)
      expect([...sockets].every((socket) => socket.destroyed)).toBe(true)
    } finally {
      client.destroy()
      await closeServer(server)
    }
  })
})
