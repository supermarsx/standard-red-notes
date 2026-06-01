import type { Provider, ProviderRequest, ProviderEvent } from './types.js'

/**
 * Deterministic provider for tests and `openclaw doctor`. Plays back a
 * pre-recorded script of events, one item per `send()` call. The script
 * lets tests assert agent-loop control flow (tool dispatch, retry caps,
 * stop reasons) without an LLM.
 */
export class MockProvider implements Provider {
  readonly id = 'mock'
  private cursor = 0

  constructor(private readonly script: ProviderEvent[][]) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *send(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const turn = this.script[this.cursor++]
    if (!turn) {
      yield { kind: 'finish', stopReason: 'end_turn' }
      return
    }
    for (const ev of turn) {
      yield ev
    }
  }
}
