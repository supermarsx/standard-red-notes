import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import {
  SANDBOX_CONSOLE_CHANNEL,
  SANDBOX_CONSOLE_LIMIT_NOTICE,
  SANDBOX_CONSOLE_MAX_ENTRIES,
  SANDBOX_CONSOLE_MAX_MESSAGE_LENGTH,
  SANDBOX_CONSOLE_TRUNCATION_SUFFIX,
  SANDBOX_RUN_CHANNEL,
  SANDBOX_RUN_MAX_PAYLOAD_BYTES,
  SANDBOX_RUN_PAYLOAD_LIMIT_MESSAGE,
} from './SandboxDocument'

const SANDBOX_NONCE = '0123456789abcdef0123456789abcdef'
const WORKER_CHANNEL = '__SN_SANDBOX_WORKER__'

const runnerHtml = readFileSync(resolve(__dirname, '../../../../sandbox.html'), 'utf8')
const runnerSource = runnerHtml.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1]

if (!runnerSource) {
  throw new Error('Unable to extract the fixed sandbox runner bootstrap.')
}

type Listener = (event: { data?: unknown; source?: unknown; message?: string; preventDefault?: () => void }) => void

const createRunnerHarness = () => {
  const parent = { postMessage: jest.fn() }
  const windowListeners = new Map<string, Listener[]>()
  const blobSources = new Map<string, string>()
  const timers: Array<{ callback: () => void; cleared: boolean }> = []
  const sandboxStyle = { textContent: '' }
  const sandboxRoot = { innerHTML: '', textContent: '' }

  class FakeBlob {
    readonly source: string

    constructor(parts: Array<string | { toString(): string }>) {
      this.source = parts.map((part) => String(part)).join('')
    }
  }

  class FakeWorker {
    static instances: FakeWorker[] = []

    readonly listeners = new Map<string, Listener[]>()
    readonly postMessage = jest.fn()
    readonly terminate = jest.fn()
    readonly source: string

    constructor(url: string) {
      const source = blobSources.get(url)
      if (!source) {
        throw new Error(`Missing fake blob URL: ${url}`)
      }
      this.source = source
      FakeWorker.instances.push(this)
    }

    addEventListener(type: string, listener: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
    }

    emitMessage(data: unknown) {
      for (const listener of this.listeners.get('message') ?? []) {
        listener({ data })
      }
    }
  }

  const context = {
    Blob: FakeBlob,
    Worker: FakeWorker,
    URL: {
      createObjectURL: (blob: FakeBlob) => {
        const url = `blob:sandbox-${blobSources.size + 1}`
        blobSources.set(url, blob.source)
        return url
      },
      revokeObjectURL: jest.fn(),
    },
    clearTimeout: (timerId: number) => {
      if (timers[timerId]) {
        timers[timerId].cleared = true
      }
    },
    console,
    document: {
      getElementById: (id: string) => (id === 'sandbox-style' ? sandboxStyle : sandboxRoot),
    },
    location: { hash: `#${SANDBOX_NONCE}` },
    parent,
    setTimeout: (callback: () => void) => {
      timers.push({ callback, cleared: false })
      return timers.length - 1
    },
    window: {
      addEventListener: (type: string, listener: Listener) => {
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener])
      },
    },
  }

  runInContext(runnerSource, createContext(context))

  return {
    parent,
    sandboxRoot,
    sandboxStyle,
    timers,
    workers: FakeWorker.instances,
    dispatchRun(data: unknown, source: unknown = parent) {
      for (const listener of windowListeners.get('message') ?? []) {
        listener({ data, source })
      }
    },
  }
}

const validRunPayload = (script = "console.log('ready')") => ({
  channel: SANDBOX_RUN_CHANNEL,
  nonce: SANDBOX_NONCE,
  document: { html: '<main>Preview</main>', css: 'main { color: red; }', js: script },
  captureConsole: true,
})

const executeWorkerSource = async (source: string, payload: unknown) => {
  const messages: Array<Record<string, unknown>> = []
  const listeners = new Map<string, Listener[]>()
  const workerGlobal: Record<string, unknown> = {
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    console: {},
    postMessage: (message: Record<string, unknown>) => messages.push(message),
  }
  workerGlobal.self = workerGlobal

  runInContext(source, createContext(workerGlobal))
  for (const listener of listeners.get('message') ?? []) {
    listener({ data: payload })
  }
  await Promise.resolve()
  await Promise.resolve()

  return messages
}

describe('fixed sandbox runner', () => {
  it('does not create a worker before an explicit, matching Run message', () => {
    const harness = createRunnerHarness()

    expect(harness.workers).toHaveLength(0)
    harness.dispatchRun({ ...validRunPayload(), nonce: 'wrong-nonce' })
    expect(harness.workers).toHaveLength(0)
  })

  it('accepts one matching payload and rejects replay', () => {
    const harness = createRunnerHarness()
    const payload = validRunPayload()

    harness.dispatchRun(payload)
    harness.dispatchRun(payload)

    expect(harness.workers).toHaveLength(1)
    expect(harness.workers[0].postMessage).toHaveBeenCalledTimes(1)
    expect(harness.workers[0].postMessage).toHaveBeenCalledWith({
      channel: WORKER_CHANNEL,
      nonce: SANDBOX_NONCE,
      script: payload.document.js,
      captureConsole: true,
    })
  })

  it('rejects oversized UTF-8 content before assigning DOM or starting a worker', () => {
    const harness = createRunnerHarness()
    const payload = validRunPayload()
    payload.document = {
      html: '😀'.repeat(SANDBOX_RUN_MAX_PAYLOAD_BYTES / 4 + 1),
      css: 'body { animation: spin 1ms infinite; }',
      js: 'while (true) {}',
    }

    harness.dispatchRun(payload)

    expect(harness.workers).toHaveLength(0)
    expect(harness.sandboxStyle.textContent).toBe('')
    expect(harness.sandboxRoot.innerHTML).toBe('')
    expect(harness.sandboxRoot.textContent).toBe(SANDBOX_RUN_PAYLOAD_LIMIT_MESSAGE)
    expect(harness.parent.postMessage).toHaveBeenCalledWith(
      {
        channel: SANDBOX_CONSOLE_CHANNEL,
        level: 'error',
        message: SANDBOX_RUN_PAYLOAD_LIMIT_MESSAGE,
      },
      '*',
    )
  })

  it('terminates non-yielding execution at the fixed deadline', () => {
    const harness = createRunnerHarness()
    harness.dispatchRun(validRunPayload('while (true) {}'))

    expect(harness.timers).toHaveLength(1)
    harness.timers[0].callback()

    expect(harness.workers[0].terminate).toHaveBeenCalledTimes(1)
    expect(harness.parent.postMessage).toHaveBeenCalledWith(
      {
        channel: SANDBOX_CONSOLE_CHANNEL,
        level: 'error',
        message: 'Execution timed out after 2000 ms.',
      },
      '*',
    )
  })

  it('bounds worker console volume and individual message size', async () => {
    const harness = createRunnerHarness()
    const oversized = SANDBOX_CONSOLE_MAX_MESSAGE_LENGTH + 100
    const script = `console.log('x'.repeat(${oversized})); for (var i = 0; i < ${SANDBOX_CONSOLE_MAX_ENTRIES}; i += 1) console.log('entry', i)`
    harness.dispatchRun(validRunPayload(script))
    const worker = harness.workers[0]
    const workerPayload = worker.postMessage.mock.calls[0][0]

    const messages = await executeWorkerSource(worker.source, workerPayload)
    const consoleMessages = messages.filter((message) => message.type === 'console')

    expect(consoleMessages).toHaveLength(SANDBOX_CONSOLE_MAX_ENTRIES)
    expect(consoleMessages[0].message).toHaveLength(SANDBOX_CONSOLE_MAX_MESSAGE_LENGTH)
    expect(String(consoleMessages[0].message).endsWith(SANDBOX_CONSOLE_TRUNCATION_SUFFIX)).toBe(true)
    expect(consoleMessages.at(-1)).toMatchObject({
      channel: WORKER_CHANNEL,
      nonce: SANDBOX_NONCE,
      type: 'console',
      level: 'warn',
      message: SANDBOX_CONSOLE_LIMIT_NOTICE,
    })
  })

  it('bounds execution errors inside the worker before crossing the frame boundary', async () => {
    const harness = createRunnerHarness()
    harness.dispatchRun(validRunPayload(`throw new Error('x'.repeat(${SANDBOX_CONSOLE_MAX_MESSAGE_LENGTH + 100}))`))
    const worker = harness.workers[0]
    const messages = await executeWorkerSource(worker.source, worker.postMessage.mock.calls[0][0])
    const errorMessage = messages.find((message) => message.type === 'console')

    expect(errorMessage?.message).toHaveLength(SANDBOX_CONSOLE_MAX_MESSAGE_LENGTH)
    expect(String(errorMessage?.message).endsWith(SANDBOX_CONSOLE_TRUNCATION_SUFFIX)).toBe(true)
    expect(messages.at(-1)?.type).toBe('complete')
  })
})
