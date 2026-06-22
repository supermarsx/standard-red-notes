import { describe, expect, it } from 'vitest'
import * as zlib from 'node:zlib'
import { decodeSqsBodyToDispatch } from '../src/sqsConsumer.js'

function snsEnvelope(event: unknown): string {
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(event))).toString('base64')
  return JSON.stringify({ Type: 'Notification', TopicArn: 'arn:...', Message: compressed })
}

const wsEvent = {
  type: 'WEB_SOCKET_MESSAGE_REQUESTED',
  createdAt: new Date().toISOString(),
  payload: {
    userUuid: 'user-1',
    message: JSON.stringify({ type: 'ITEMS_CHANGED_ON_SERVER', payload: { userUuid: 'user-1' } }),
    originatingSessionUuid: 'sess-A',
  },
}

describe('decodeSqsBodyToDispatch', () => {
  it('decodes a gzip+base64 SNS->SQS envelope of WEB_SOCKET_MESSAGE_REQUESTED', () => {
    const parsed = decodeSqsBodyToDispatch(snsEnvelope(wsEvent))
    expect(parsed).not.toBeNull()
    expect(parsed!.userUuid).toBe('user-1')
    expect(parsed!.originatingSessionUuid).toBe('sess-A')
    expect(parsed!.message).toContain('ITEMS_CHANGED_ON_SERVER')
  })

  it('also handles a deflate-compressed message (unzip auto-detects)', () => {
    const compressed = zlib.deflateSync(Buffer.from(JSON.stringify(wsEvent))).toString('base64')
    const body = JSON.stringify({ Message: compressed })
    const parsed = decodeSqsBodyToDispatch(body)
    expect(parsed?.userUuid).toBe('user-1')
  })

  it('returns null for non-websocket events', () => {
    const other = { ...wsEvent, type: 'SOME_OTHER_EVENT' }
    expect(decodeSqsBodyToDispatch(snsEnvelope(other))).toBeNull()
  })

  it('returns null for malformed bodies', () => {
    expect(decodeSqsBodyToDispatch('not json')).toBeNull()
    expect(decodeSqsBodyToDispatch(JSON.stringify({ Message: 'not-base64-zlib!!!' }))).toBeNull()
  })

  it('returns null when payload is missing required fields', () => {
    const bad = { type: 'WEB_SOCKET_MESSAGE_REQUESTED', payload: { userUuid: 'u' } }
    expect(decodeSqsBodyToDispatch(snsEnvelope(bad))).toBeNull()
  })
})
