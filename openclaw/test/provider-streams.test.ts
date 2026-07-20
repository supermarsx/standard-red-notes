import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "../src/providers/ollama.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import type {
  ProviderEvent,
  ProviderRequest,
  ToolDescriptor,
} from "../src/providers/types.js";

/**
 * Stream-decoding edge cases for the two native providers: partial tool-call
 * assembly, malformed payloads, and transport failure. providers.test.ts covers
 * the happy paths.
 */

const tools: ToolDescriptor[] = [
  {
    name: "notes.search",
    description: "search notes",
    inputSchema: { type: "object" },
  },
];

function request(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    system: "SYSTEM",
    messages: [{ role: "user", content: "hello" }],
    tools,
    ...over,
  };
}

async function collect(stream: AsyncIterable<ProviderEvent>) {
  const out: ProviderEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("OllamaProvider stream decoding", () => {
  afterEach(() => vi.unstubAllGlobals());

  function streamingResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  function stubFetch(response: Response) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const line = (obj: object) => JSON.stringify(obj) + "\n";

  it("reports an HTTP failure as an error event and stops", async () => {
    stubFetch(new Response(null, { status: 500, statusText: "Boom" }));

    const events = await collect(
      new OllamaProvider("llama3.1").send(request()),
    );

    expect(events).toEqual([
      { kind: "error", message: "ollama: 500 Boom" },
      { kind: "finish", stopReason: "error" },
    ]);
  });

  it("skips blank and unparseable lines rather than aborting", async () => {
    stubFetch(
      streamingResponse([
        "\n",
        "  \n",
        "{broken\n",
        line({ message: { content: "survived" }, done: true }),
      ]),
    );

    const events = await collect(
      new OllamaProvider("llama3.1").send(request()),
    );

    expect(events).toContainEqual({ kind: "text-delta", delta: "survived" });
    expect(events.at(-1)).toEqual({ kind: "finish", stopReason: "end_turn" });
  });

  it("emits tool calls with sequential ids and finishes for length", async () => {
    stubFetch(
      streamingResponse([
        line({
          message: {
            tool_calls: [
              { function: { name: "notes.search", arguments: { q: "a" } } },
              { function: { name: "notes.create", arguments: { t: "b" } } },
            ],
          },
        }),
        line({ done: true, done_reason: "length" }),
      ]),
    );

    const events = await collect(
      new OllamaProvider("llama3.1").send(request()),
    );

    expect(events.filter((e) => e.kind === "tool-call")).toEqual([
      {
        kind: "tool-call",
        id: "ollama_call_0",
        name: "notes.search",
        args: { q: "a" },
      },
      {
        kind: "tool-call",
        id: "ollama_call_1",
        name: "notes.create",
        args: { t: "b" },
      },
    ]);
    expect(events.at(-1)).toEqual({
      kind: "finish",
      stopReason: "max_tokens",
    });
  });

  it("defaults absent tool-call arguments to an empty object on the wire", async () => {
    const fetchMock = stubFetch(
      streamingResponse([line({ message: { content: "ok" }, done: true })]),
    );

    await collect(
      new OllamaProvider("llama3.1").send(
        request({
          messages: [
            {
              role: "assistant",
              content: "checking",
              toolCalls: [
                { id: "c1", name: "notes.search", args: undefined as never },
              ],
            },
          ],
        }),
      ),
    );

    const { messages } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(messages[1].tool_calls).toEqual([
      { function: { name: "notes.search", arguments: {} } },
    ]);
  });
});

describe("OpenAIProvider stream decoding", () => {
  const saved = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  });

  function withStubbedStream(provider: OpenAIProvider, chunks: unknown[]) {
    const create = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    });
    (provider as unknown as { client: unknown }).client = {
      chat: { completions: { create } },
    };
    return create;
  }

  it("skips a chunk that carries no choices", async () => {
    const provider = new OpenAIProvider("gpt-4o-mini");
    withStubbedStream(provider, [
      { choices: [] },
      { choices: [{ delta: { content: "text" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);

    const events = await collect(provider.send(request()));

    expect(events.filter((e) => e.kind === "text-delta")).toEqual([
      { kind: "text-delta", delta: "text" },
    ]);
  });

  it("assembles tool-call arguments streamed across several chunks", async () => {
    const provider = new OpenAIProvider("gpt-4o-mini");
    withStubbedStream(provider, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  function: { name: "notes.search", arguments: '{"q":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"budget"}' } }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);

    const events = await collect(provider.send(request()));

    expect(events).toContainEqual({
      kind: "tool-call",
      id: "call_abc",
      name: "notes.search",
      args: { q: "budget" },
    });
  });

  it("falls back to an index-derived id and empty args when the model omits them", async () => {
    const provider = new OpenAIProvider("gpt-4o-mini");
    withStubbedStream(provider, [
      {
        choices: [{ delta: { tool_calls: [{ index: 2, function: {} }] } }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);

    const events = await collect(provider.send(request()));

    expect(events).toContainEqual({
      kind: "tool-call",
      id: "call_2",
      name: "",
      args: {},
    });
  });

  it("falls back to empty args when the streamed JSON is unparseable", async () => {
    const provider = new OpenAIProvider("gpt-4o-mini");
    withStubbedStream(provider, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_bad",
                  function: { name: "notes.search", arguments: "{oops" },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);

    const events = await collect(provider.send(request()));

    expect(events).toContainEqual({
      kind: "tool-call",
      id: "call_bad",
      name: "notes.search",
      args: {},
    });
  });
});
