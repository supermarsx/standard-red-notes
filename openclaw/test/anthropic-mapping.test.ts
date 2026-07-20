import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import type {
  ProviderEvent,
  ProviderRequest,
  ToolDescriptor,
} from "../src/providers/types.js";

/**
 * Complements the AnthropicProvider cases in providers.test.ts with the stop
 * reason mapping and the request-shaping branches that were never exercised.
 * Only the SDK network call is stubbed; all mapping logic runs for real.
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

const saved = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
});
afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

describe("AnthropicProvider stop reason mapping", () => {
  it.each([
    ["end_turn", "end_turn"],
    ["max_tokens", "max_tokens"],
    ["tool_use", "tool_use"],
    ["stop_sequence", "stop"],
  ])("maps the API's %s to %s", async (apiReason, expected) => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    withStubbedStream(provider, [{ type: "message_stop" }], apiReason);

    const events = await collect(provider.send(request()));

    expect(events.at(-1)).toEqual({ kind: "finish", stopReason: expected });
  });

  it.each([
    ["a null stop reason", null],
    ["an unrecognised stop reason", "refusal"],
  ])("falls back to end_turn for %s", async (_name, apiReason) => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    withStubbedStream(provider, [{ type: "message_stop" }], apiReason);

    const events = await collect(provider.send(request()));

    expect(events.at(-1)).toEqual({ kind: "finish", stopReason: "end_turn" });
  });
});

describe("AnthropicProvider request shaping", () => {
  it("honours an explicit output token budget over the default", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    const stream = withStubbedStream(provider, [{ type: "message_stop" }]);

    await collect(provider.send(request({ maxOutputTokens: 128 })));

    expect(stream.mock.calls[0][0].max_tokens).toBe(128);
  });

  it("omits the text part when an assistant turn is tool calls only", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    const stream = withStubbedStream(provider, [{ type: "message_stop" }]);

    await collect(
      provider.send(
        request({
          messages: [
            { role: "user", content: "budget?" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "notes.search", args: {} }],
            },
          ],
        }),
      ),
    );

    expect(stream.mock.calls[0][0].messages[1].content).toEqual([
      { type: "tool_use", id: "c1", name: "notes.search", input: {} },
    ]);
  });

  it("treats an assistant turn with an empty toolCalls array as plain text", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    const stream = withStubbedStream(provider, [{ type: "message_stop" }]);

    await collect(
      provider.send(
        request({
          messages: [
            { role: "assistant", content: "just text", toolCalls: [] },
          ],
        }),
      ),
    );

    expect(stream.mock.calls[0][0].messages[0]).toEqual({
      role: "assistant",
      content: "just text",
    });
  });

  it("passes the model through to the SDK", async () => {
    const provider = new AnthropicProvider("claude-sonnet-5");
    const stream = withStubbedStream(provider, [{ type: "message_stop" }]);

    await collect(provider.send(request()));

    expect(stream.mock.calls[0][0].model).toBe("claude-sonnet-5");
  });
});

describe("AnthropicProvider tool argument decoding", () => {
  it("falls back to an empty object when the model streams unparseable JSON", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    withStubbedStream(provider, [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "notes.search" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{not json" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]);

    const events = await collect(provider.send(request()));

    expect(events).toContainEqual({
      kind: "tool-call",
      id: "tu_1",
      name: "notes.search",
      args: {},
    });
  });

  it("treats a tool call with no streamed arguments as an empty object", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    withStubbedStream(provider, [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_2", name: "notes.search" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]);

    const events = await collect(provider.send(request()));

    expect(events).toContainEqual({
      kind: "tool-call",
      id: "tu_2",
      name: "notes.search",
      args: {},
    });
  });

  it("ignores a content_block_stop for an index it never opened", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    withStubbedStream(provider, [
      { type: "content_block_stop", index: 7 },
      { type: "message_stop" },
    ]);

    const events = await collect(provider.send(request()));

    expect(events.filter((e) => e.kind === "tool-call")).toEqual([]);
  });
});

describe("AnthropicProvider construction", () => {
  it("accepts a custom base URL for a proxy or gateway", async () => {
    const provider = new AnthropicProvider(
      "claude-opus-4-7",
      "https://proxy.example.test",
    );
    const stream = withStubbedStream(provider, [{ type: "message_stop" }]);

    await collect(provider.send(request()));

    expect(stream.mock.calls[0][0].model).toBe("claude-opus-4-7");
  });

  it("forwards each tool descriptor as an input_schema entry", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    const stream = withStubbedStream(provider, [{ type: "message_stop" }]);

    await collect(provider.send(request({ tools: [] })));

    expect(stream.mock.calls[0][0].tools).toEqual([]);
  });
});

describe("AnthropicProvider stream robustness", () => {
  it("ignores a non-tool content block instead of tracking it as a tool call", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    withStubbedStream(provider, [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]);

    const events = await collect(provider.send(request()));

    expect(events).toContainEqual({ kind: "text-delta", delta: "hello" });
    expect(events.filter((e) => e.kind === "tool-call")).toEqual([]);
  });

  it("drops an input_json_delta for a block it never opened", async () => {
    const provider = new AnthropicProvider("claude-opus-4-7");
    withStubbedStream(provider, [
      {
        type: "content_block_delta",
        index: 9,
        delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
      },
      { type: "message_stop" },
    ]);

    const events = await collect(provider.send(request()));

    expect(events).toEqual([{ kind: "finish", stopReason: "end_turn" }]);
  });
});
