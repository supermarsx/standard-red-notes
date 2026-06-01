import { app, BrowserWindow } from 'electron'
import { AppMessageType, MessageType, TestIPCMessage } from '../../../../test/TestIpcMessage'
import { isTesting } from '../Utils/Utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handlers are intentionally heterogeneous across message types
type Handler = (...args: any[]) => unknown

const messageHandlers: {
  [key in MessageType]?: Handler
} = {}

export function handleTestMessage(type: MessageType, handler: Handler): void {
  if (!isTesting()) {
    throw Error('Tried to invoke test handler in non-test build.')
  }

  messageHandlers[type] = handler
}

export function send(type: AppMessageType, data?: unknown): void {
  if (!isTesting()) {
    return
  }

  process.send!({ type, data })
}

export function setupTesting(): void {
  process.on('message', async (message: TestIPCMessage) => {
    const handler = messageHandlers[message.type]

    if (!handler) {
      process.send!({
        id: message.id,
        reject: `No handler registered for message type ${MessageType[message.type]}`,
      })
      return
    }

    try {
      let returnValue = handler(...message.args)
      if (returnValue instanceof Promise) {
        returnValue = await returnValue
      }
      process.send!({
        id: message.id,
        resolve: returnValue,
      })
    } catch (error) {
      process.send!({
        id: message.id,
        reject: String(error),
      })
    }
  })

  handleTestMessage(MessageType.WindowCount, () => BrowserWindow.getAllWindows().length)

  app.on('ready', () => {
    setTimeout(() => {
      send(AppMessageType.Ready)
    }, 200)
  })
}
