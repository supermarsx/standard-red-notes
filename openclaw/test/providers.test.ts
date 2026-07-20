import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveProvider } from "../src/providers/factory.js";
import { MockProvider } from "../src/providers/mock.js";
import { OllamaProvider } from "../src/providers/ollama.js";
import { HermesProvider } from "../src/providers/hermes/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { providerSchema } from "../src/config/schema.js";
import type {
  ProviderEvent,
  ProviderRequest,
  ToolDescriptor,
} from "../src/providers/types.js";

const tools: ToolDescriptor[] = [
  {
    name: "notes.search",
    description: "search notes",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
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

async function collect(
  events: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

/** Build a Response-like object streaming the given chunks as a body. */
function streamingResponse(chunks: string[], ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Server Error",
    body: {
      getReader() {
        let index = 0;
        const encoder = new TextEncoder();
        return {
          read: async () =>
            index < chunks.length
              ? { done: false, value: encoder.encode(chunks[index++]) }
              : { done: true, value: undefined },
        };
      },
    },
  } as unknown as Response;
}

describe("resolveProvider", () => {
  const savedKeys = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  beforeEach(() => {
    // The SDK clients refuse to construct without a key; the factory under
    // test only ever wires config values into the constructors.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(savedKeys)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("maps each config type onto the matching provider class", () => {
    expect(
      resolveProvider(providerSchema.parse({ type: "anthropic" })),
    ).toBeInstanceOf(AnthropicProvider);
    expect(
      resolveProvider(providerSchema.parse({ type: "openai" })),
    ).toBeInstanceOf(OpenAIProvider);
    expect(
      resolveProvider(providerSchema.parse({ type: "ollama" })),
    ).toBeInstanceOf(OllamaProvider);
    expect(
      resolveProvider(providerSchema.parse({ type: "hermes" })),
    ).toBeInstanceOf(HermesProvider);
    expect(
      resolveProvider(providerSchema.parse({ type: "mock" })),
    ).toBeInstanceOf(MockProvider);
  });

  it("exposes a distinct id per provider", () => {
    const ids = (["anthropic", "openai", "ollama", "hermes", "mock"] as const)
      .map((type) => resolveProvider(providerSchema.parse({ type })).id)
      .sort();
    expect(ids).toEqual(["anthropic", "hermes", "mock", "ollama", "openai"]);
  });

  it("passes the configured model and base_url through to the provider", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        streamingResponse([JSON.stringify({ done: true }) + "\n"]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = resolveProvider(
      providerSchema.parse({
        type: "ollama",
        model: "qwen2.5",
        base_url: "http://10.0.0.5:1234",
      }),
    );
    await collect(provider.send(request()));
    expect(fetchMock.mock.calls[0][0]).toBe("http://10.0.0.5:1234/api/chat");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("qwen2.5");
    vi.unstubAllGlobals();
  });

  it("reads the hermes API key from the configured env var", async () => {
    process.env.OPENCLAW_TEST_KEY = "sk-from-env";
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(streamingResponse(["data: [DONE]\n"]));
      vi.stubGlobal("fetch", fetchMock);
      const provider = resolveProvider(
        providerSchema.parse({
          type: "hermes",
          transport: "openai",
          api_key_env: "OPENCLAW_TEST_KEY",
        }),
      );
      await collect(provider.send(request()));
      expect(fetchMock.mock.calls[0][1].headers.authorization).toBe(
        "Bearer sk-from-env",
      );
      vi.unstubAllGlobals();
    } finally {
      delete process.env.OPENCLAW_TEST_KEY;
    }
  });

  it("sends no authorization header when no api_key_env is configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(streamingResponse(["data: [DONE]\n"]));
    vi.stubGlobal("fetch", fetchMock);
    const provider = resolveProvider(
      providerSchema.parse({ type: "hermes", transport: "openai" }),
    );
    await collect(provider.send(request()));
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("MockProvider", () => {
  it("replays one scripted turn per send() call", async () => {
    const provider = new MockProvider([
      [
        { kind: "text-delta", delta: "first" },
        { kind: "finish", stopReason: "end_turn" },
      ],
      [
        { kind: "text-delta", delta: "second" },
        { kind: "finish", stopReason: "end_turn" },
      ],
    ]);
    expect(await collect(provider.send(request()))).toEqual([
      { kind: "text-delta", delta: "first" },
      { kind: "finish", stopReason: "end_turn" },
    ]);
    expect(await collect(provider.send(request()))).toEqual([
      { kind: "text-delta", delta: "second" },
      { kind: "finish", stopReason: "end_turn" },
    ]);
  });

  it("finishes cleanly once the script is exhausted", async () => {
    const provider = new MockProvider([]);
    expect(await collect(provider.send(request()))).toEqual([
      { kind: "finish", stopReason: "end_turn" },
    ]);
  });
});

describe("OllamaProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(response: Response) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts the system prompt first and declares tools as functions", async () => {
    const fetchMock = stubFetch(
      streamingResponse([JSON.stringify({ done: true }) + "\n"]),
    );
    await collect(new OllamaProvider("llama3.1").send(request()));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: "system", content: "SYSTEM" });
    expect(body.messages[1]).toMatchObject({ role: "user", content: "hello" });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "notes.search",
          description: "search notes",
          parameters: tools[0].inputSchema,
        },
      },
    ]);
  });

  it("forwards prior assistant tool calls in the ollama wire shape", async () => {
    const fetchMock = stubFetch(
      streamingResponse([JSON.stringify({ done: true }) + "\n"]),
    );
    await collect(
      new OllamaProvider("llama3.1").send(
        request({
          messages: [
            {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "c1", name: "notes.search", args: { query: "rent" } },
              ],
            },
          ],
        }),
      ),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[1].tool_calls).toEqual([
      { function: { name: "notes.search", arguments: { query: "rent" } } },
    ]);
  });

  it("streams text deltas and finishes on done", async () => {
    stubFetch(
      streamingResponse([
        JSON.stringify({ message: { content: "Hel" }, done: false }) + "\n",
        JSON.stringify({ message: { content: "lo" }, done: false }) + "\n",
        JSON.stringify({ done: true }) + "\n",
      ]),
    );
    const events = await collect(
      new OllamaProvider("llama3.1").send(request()),
    );
    expect(events).toEqual([
      { kind: "text-delta", delta: "Hel" },
      { kind: "text-delta", delta: "lo" },
      { kind: "finish", stopReason: "end_turn" },
    ]);
  });

  it("reassembles NDJSON lines split across chunk boundaries", async () => {
    const line = JSON.stringify({ message: { content: "split" }, done: false });
    stubFetch(
      streamingResponse([
        line.slice(0, 10),
        line.slice(10) + "\n" + JSON.stringify({ done: true }) + "\n",
      ]),
    );
    const events = await collect(
      new OllamaProvider("llama3.1").send(request()),
    );
    expect(events[0]).toEqual({ kind: "text-delta", delta: "split" });
    expect(events).toHaveLength(2);
  });

  it("emits sequentially numbered tool-call ids", async () => {
    stubFetch(
      streamingResponse([
        JSON.stringify({
          message: {
            tool_calls: [
              { function: { name: "a", arguments: { x: 1 } } },
              { function: { name: "b", arguments: {} } },
            ],
          },
          done: false,
        }) + "\n",
        JSON.stringify({ done: true }) + "\n",
      ]),
    );
    const events = await collect(
      new OllamaProvider("llama3.1").send(request()),
    );
    expect(events.slice(0, 2)).toEqual([
      { kind: "tool-call", id: "ollama_call_0", name: "a", args: { x: 1 } },
      { kind: "tool-call", id: "ollama_call_1", name: "b", args: {} },
    ]);
  });

  it("maps done_reason length onto max_tokens", async () => {
    stubFetch(
      streamingResponse([
        JSON.stringify({ done: true, done_reason: "length" }) + "\n",
      ]),
    );
    const events = await collect(
      new OllamaProvider("llama3.1").send(request()),
    );
    expect(events).toEqual([{ kind: "finish", stopReason: "max_tokens" }]);
  });

  it("skips unparsable lines instead of throwing", async () => {
    stubFetch(
      streamingResponse([
        "{not json}\n",
        "\n",
        JSON.stringify({ message: { content: "ok" }, done: true }) + "\n",
      ]),
    );
    const events = await collect(
      new OllamaProvider("llama3.1").send(request()),
    );
    expect(events).toEqual([
      { kind: "text-delta", delta: "ok" },
      { kind: "finish", stopReason: "end_turn" },
    ]);
  });

  it("reports an HTTP failure as error + finish(error)", async () => {
    stubFetch(streamingResponse([], false, 503));
    const events = await collect(
      new OllamaProvider("llama3.1").send(request()),
    );
    expect(events).toEqual([
      { kind: "error", message: "ollama: 503 Server Error" },
      { kind: "finish", stopReason: "error" },
    ]);
  });
});

describe("HermesProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(response: Response) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const ollamaLine = (content: string, extra: object = {}) =>
    JSON.stringify({ message: { content }, ...extra }) + "\n";

  it("never sends a native tools parameter; schemas go in the system prompt", async () => {
    const fetchMock = stubFetch(streamingResponse([ollamaLine("hi")]));
    await collect(new HermesProvider("hermes3").send(request()));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("SYSTEM");
    expect(body.messages[0].content).toContain("<tools>");
    expect(body.messages[0].content).toContain('"name": "notes.search"');
  });

  it("passes maxOutputTokens as num_predict on the ollama transport", async () => {
    const fetchMock = stubFetch(streamingResponse([ollamaLine("hi")]));
    await collect(
      new HermesProvider("hermes3").send(request({ maxOutputTokens: 128 })),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options).toEqual({ num_predict: 128 });
  });

  it("parses <tool_call> blocks out of streamed prose", async () => {
    stubFetch(
      streamingResponse([
        ollamaLine("Let me look. <tool_"),
        ollamaLine('call>{"name": "notes.search", "arguments": {"q": "x"}}'),
        ollamaLine("</tool_call>", { done: true }),
      ]),
    );
    const events = await collect(new HermesProvider("hermes3").send(request()));
    expect(events).toContainEqual({
      kind: "tool-call",
      id: "hermes_call_0",
      name: "notes.search",
      args: { q: "x" },
    });
    expect(events.at(-1)).toEqual({ kind: "finish", stopReason: "tool_use" });
    const prose = events
      .filter((e) => e.kind === "text-delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(prose).toContain("Let me look.");
    expect(prose).not.toContain("tool_call");
  });

  it("finishes end_turn for plain prose and max_tokens when capped", async () => {
    stubFetch(streamingResponse([ollamaLine("just text")]));
    expect(
      (await collect(new HermesProvider("hermes3").send(request()))).at(-1),
    ).toEqual({ kind: "finish", stopReason: "end_turn" });

    stubFetch(
      streamingResponse([ollamaLine("cut off", { done_reason: "length" })]),
    );
    expect(
      (await collect(new HermesProvider("hermes3").send(request()))).at(-1),
    ).toEqual({ kind: "finish", stopReason: "max_tokens" });
  });

  it("renders tool results back as <tool_response> user turns", async () => {
    const fetchMock = stubFetch(streamingResponse([ollamaLine("ok")]));
    await collect(
      new HermesProvider("hermes3").send(
        request({
          messages: [
            { role: "user", content: "budget?" },
            {
              role: "assistant",
              content: "checking",
              toolCalls: [{ id: "c1", name: "notes.search", args: { q: "b" } }],
            },
            {
              role: "tool",
              toolCallId: "c1",
              content: '{"hits":[]}',
            },
            { role: "tool", toolCallId: "c2", content: "plain text" },
          ],
        }),
      ),
    );
    const { messages } = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Prior assistant tool calls are re-rendered as <tool_call> text.
    expect(messages[2]).toEqual({
      role: "assistant",
      content:
        'checking\n<tool_call>{"name":"notes.search","arguments":{"q":"b"}}</tool_call>',
    });
    // JSON results are passed through verbatim inside the tags...
    expect(messages[3]).toEqual({
      role: "user",
      content: '<tool_response>{"hits":[]}</tool_response>',
    });
    // ...while non-JSON results are wrapped so the payload is always JSON.
    expect(messages[4]).toEqual({
      role: "user",
      content: '<tool_response>{"result":"plain text"}</tool_response>',
    });
  });

  it("uses the OpenAI chat-completions wire format on the openai transport", async () => {
    const fetchMock = stubFetch(
      streamingResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
        "data: [DONE]\n",
      ]),
    );
    const events = await collect(
      new HermesProvider(
        "hermes3",
        "http://lmstudio.local:1234/v1",
        "openai",
      ).send(request({ maxOutputTokens: 42, stop: ["\nUser:"] })),
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://lmstudio.local:1234/v1/chat/completions",
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(42);
    expect(body.stop).toEqual(["\nUser:"]);
    expect(body.stream).toBe(true);
    expect(events).toEqual([
      { kind: "text-delta", delta: "hi" },
      { kind: "finish", stopReason: "end_turn" },
    ]);
  });

  it("ignores non-data SSE lines and unparsable payloads", async () => {
    stubFetch(
      streamingResponse([
        ": keep-alive\n",
        "data: {oops\n",
        'data: {"choices":[{"delta":{"content":"fine"},"finish_reason":"length"}]}\n',
        "data: [DONE]\n",
      ]),
    );
    const events = await collect(
      new HermesProvider("hermes3", "http://x/v1", "openai").send(request()),
    );
    expect(events).toEqual([
      { kind: "text-delta", delta: "fine" },
      { kind: "finish", stopReason: "max_tokens" },
    ]);
  });

  it("surfaces a transport failure as error + finish(error)", async () => {
    stubFetch(streamingResponse([], false, 500));
    const events = await collect(new HermesProvider("hermes3").send(request()));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "error" });
    expect((events[0] as { message: string }).message).toContain(
      "hermes: Error: 500",
    );
    expect(events[1]).toEqual({ kind: "finish", stopReason: "error" });
  });
});

describe("OpenAIProvider", () => {
  const saved = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  });

  /** Replace only the SDK network call, keeping all mapping logic real. */
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

  it("prepends the system message and maps tool/assistant turns", async () => {
    const provider = new OpenAIProvider("gpt-4o-mini");
    const create = withStubbedStream(provider, [
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    await collect(
      provider.send(
        request({
          messages: [
            { role: "user", content: "budget?" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "notes.search", args: { q: "b" } }],
            },
            { role: "tool", toolCallId: "c1", content: "{}" },
          ],
        }),
      ),
    );
    const body = create.mock.calls[0][0];
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: "system", content: "SYSTEM" });
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "notes.search", arguments: '{"q":"b"}' },
        },
      ],
    });
    expect(body.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "{}",
    });
    expect(body.tools[0].function.name).toBe("notes.search");
  });

  it("defaults max_tokens to 4096 and a missing tool_call_id to unknown", async () => {
    const provider = new OpenAIProvider("gpt-4o-mini");
    const create = withStubbedStream(provider, [
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    await collect(
      provider.send(
        request({ messages: [{ role: "tool", content: "orphan" }] }),
      ),
    );
    const body = create.mock.calls[0][0];
    expect(body.max_tokens).toBe(4096);
    expect(body.messages[1].tool_call_id).toBe("unknown");
  });

  it("accumulates streamed tool-call argument fragments into one call", async () => {
    const provider = new OpenAIProvider("gpt-4o-mini");
    withStubbedStream(provider, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
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
              tool_calls: [{ index: 0, function: { arguments: '"rent"}' } }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const events = await collect(provider.send(request()));
    expect(events).toEqual([
      {
        kind: "tool-call",
        id: "call_a",
        name: "notes.search",
        args: { q: "rent" },
      },
      { kind: "finish", stopReason: "tool_use" },
    ]);
  });

  it("falls back to empty args when the streamed JSON is malformed", async () => {
    const provider = new OpenAIProvider("gpt-4o-mini");
    withStubbedStream(provider, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: "f", arguments: "{broken" } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const events = await collect(provider.send(request()));
    expect(events[0]).toEqual({
      kind: "tool-call",
      id: "call_0",
      name: "f",
      args: {},
    });
  });

  it("maps finish_reason length onto max_tokens and emits text deltas", async () => {
    const provider = new OpenAIProvider("gpt-4o-mini");
    withStubbedStream(provider, [
      { choices: [{ delta: { content: "par" } }] },
      { choices: [{ delta: { content: "tial" }, finish_reason: "length" }] },
    ]);
    expect(await collect(provider.send(request()))).toEqual([
      { kind: "text-delta", delta: "par" },
      { kind: "text-delta", delta: "tial" },
      { kind: "finish", stopReason: "max_tokens" },
    ]);
  });
});

describe("AnthropicProvider", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  /** Replace only the SDK network call, keeping all mapping logic real. */
  function withStubbedStream(
    provider: AnthropicProvider,
    events: unknown[],
    stopReason: string | null = "end_turn",
  ) {
    const stream = vi.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
      finalMessage: async () => ({ stop_reason: stopReason }),
    });
    (provider as unknown as { client: unknown }).client = {
      messages: { stream },
    };
    return stream;
  }

  it("maps tool results to user tool_result blocks and tool calls to tool_use", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    const stream = withStubbedStream(provider, [{ type: "message_stop" }]);
    await collect(
      provider.send(
        request({
          messages: [
            { role: "user", content: "budget?" },
            {
              role: "assistant",
              content: "checking",
              toolCalls: [{ id: "c1", name: "notes.search", args: { q: "b" } }],
            },
            { role: "tool", toolCallId: "c1", content: "{}" },
            { role: "tool", content: "orphan" },
          ],
        }),
      ),
    );
    const body = stream.mock.calls[0][0];
    // The system prompt is a top-level parameter, not a message.
    expect(body.system).toBe("SYSTEM");
    expect(body.max_tokens).toBe(4096);
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "c1", name: "notes.search", input: { q: "b" } },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: "{}" }],
    });
    expect(body.messages[3].content[0].tool_use_id).toBe("unknown");
    expect(body.tools).toEqual([
      {
        name: "notes.search",
        description: "search notes",
        input_schema: tools[0].inputSchema,
      },
    ]);
  });

  it("assembles input_json_delta fragments into tool-call args at block stop", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    withStubbedStream(
      provider,
      [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_1", name: "notes.search" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"q":' },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"rent"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ],
      "tool_use",
    );
    expect(await collect(provider.send(request()))).toEqual([
      {
        kind: "tool-call",
        id: "tu_1",
        name: "notes.search",
        args: { q: "rent" },
      },
      { kind: "finish", stopReason: "tool_use" },
    ]);
  });

  it("yields text deltas and maps stop_sequence onto stop", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    withStubbedStream(
      provider,
      [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello" },
        },
        { type: "message_stop" },
      ],
      "stop_sequence",
    );
    expect(await collect(provider.send(request()))).toEqual([
      { kind: "text-delta", delta: "hello" },
      { kind: "finish", stopReason: "stop" },
    ]);
  });

  it("falls back to end_turn for an unknown or null stop reason", async () => {
    for (const reason of [null, "pause_turn"]) {
      const provider = new AnthropicProvider("claude-opus-4-7");
      withStubbedStream(provider, [{ type: "message_stop" }], reason);
      expect(await collect(provider.send(request()))).toEqual([
        { kind: "finish", stopReason: "end_turn" },
      ]);
    }
  });

  it("falls back to empty args when the streamed tool JSON is malformed", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    withStubbedStream(provider, [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "f" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{broken" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]);
    const events = await collect(provider.send(request()));
    expect(events[0]).toEqual({
      kind: "tool-call",
      id: "tu_1",
      name: "f",
      args: {},
    });
  });
});
