import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesProvider } from "../src/providers/hermes/index.js";
import type {
  ProviderEvent,
  ProviderRequest,
  ToolDescriptor,
} from "../src/providers/types.js";

/**
 * Transport-level behaviour of HermesProvider: HTTP failures, and the
 * defensive skips in the two stream decoders. providers.test.ts covers the
 * happy paths of both transports.
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

const ollamaLine = (message: object, extra: object = {}) =>
  JSON.stringify({ ...message, ...extra }) + "\n";

const ollama = () => new HermesProvider("hermes3");
const openai = () =>
  new HermesProvider("hermes3", "http://lmstudio.local/v1", "openai");

afterEach(() => vi.unstubAllGlobals());

describe("HermesProvider transport failures", () => {
  it.each([
    ["ollama", ollama],
    ["openai", openai],
  ])(
    "reports an HTTP error from the %s transport as an error event, not a throw",
    async (_name, make) => {
      stubFetch(
        new Response(null, { status: 503, statusText: "Service Unavailable" }),
      );

      const events = await collect(make().send(request()));

      expect(events).toEqual([
        { kind: "error", message: "hermes: Error: 503 Service Unavailable" },
        { kind: "finish", stopReason: "error" },
      ]);
    },
  );

  it.each([
    ["ollama", ollama],
    ["openai", openai],
  ])("treats a %s response with no body as a failure", async (_name, make) => {
    // 200 with a null body: res.ok is true, so only the !res.body half catches it.
    stubFetch(new Response(null, { status: 200, statusText: "OK" }));

    const events = await collect(make().send(request()));

    expect(events.at(0)?.kind).toBe("error");
    expect(events.at(-1)).toEqual({ kind: "finish", stopReason: "error" });
  });

  it("surfaces a rejected fetch as an error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    const events = await collect(ollama().send(request()));

    expect(events[0]).toEqual({
      kind: "error",
      message: "hermes: Error: ECONNREFUSED",
    });
  });
});

describe("HermesProvider ollama stream decoding", () => {
  it("skips blank and unparseable lines instead of aborting the stream", async () => {
    stubFetch(
      streamingResponse([
        "\n",
        "   \n",
        "{not json\n",
        ollamaLine({ message: { content: "still here" } }),
      ]),
    );

    const events = await collect(ollama().send(request()));

    expect(events).toContainEqual({ kind: "text-delta", delta: "still here" });
    expect(events.at(-1)).toEqual({ kind: "finish", stopReason: "end_turn" });
  });

  it("ignores a line that carries no message content", async () => {
    stubFetch(
      streamingResponse([
        ollamaLine({ done: false }),
        ollamaLine({ message: {} }),
        ollamaLine({ message: { content: "text" } }),
      ]),
    );

    const events = await collect(ollama().send(request()));

    expect(events.filter((e) => e.kind === "text-delta")).toEqual([
      { kind: "text-delta", delta: "text" },
    ]);
  });

  it("reassembles a JSON object split across two network chunks", async () => {
    stubFetch(
      streamingResponse([
        '{"message":{"content":"split ',
        'across"}}\n{"message":{"content":" chunks"}}\n',
      ]),
    );

    const events = await collect(ollama().send(request()));
    const prose = events
      .filter((e) => e.kind === "text-delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");

    expect(prose).toBe("split across chunks");
  });

  it("reports max_tokens when the model stops for length", async () => {
    stubFetch(
      streamingResponse([
        ollamaLine({ message: { content: "cut" } }, { done_reason: "length" }),
      ]),
    );

    expect((await collect(ollama().send(request()))).at(-1)).toEqual({
      kind: "finish",
      stopReason: "max_tokens",
    });
  });
});

describe("HermesProvider openai stream decoding", () => {
  it("stops at [DONE] and ignores anything after it", async () => {
    stubFetch(
      streamingResponse([
        'data: {"choices":[{"delta":{"content":"before"}}]}\n',
        "data: [DONE]\n",
        'data: {"choices":[{"delta":{"content":"after"}}]}\n',
      ]),
    );

    const events = await collect(openai().send(request()));
    const prose = events
      .filter((e) => e.kind === "text-delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");

    expect(prose).toBe("before");
  });

  it("skips a payload with no choices", async () => {
    stubFetch(
      streamingResponse([
        'data: {"id":"x"}\n',
        'data: {"choices":[]}\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
        "data: [DONE]\n",
      ]),
    );

    const events = await collect(openai().send(request()));

    expect(events.filter((e) => e.kind === "text-delta")).toEqual([
      { kind: "text-delta", delta: "ok" },
    ]);
  });

  it("skips a choice whose delta carries no content", async () => {
    stubFetch(
      streamingResponse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n',
        'data: {"choices":[{"delta":{}}]}\n',
        'data: {"choices":[{"delta":{"content":"body"}}]}\n',
        "data: [DONE]\n",
      ]),
    );

    const events = await collect(openai().send(request()));

    expect(events.filter((e) => e.kind === "text-delta")).toEqual([
      { kind: "text-delta", delta: "body" },
    ]);
  });

  it("reports max_tokens when the choice finishes for length", async () => {
    stubFetch(
      streamingResponse([
        'data: {"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}\n',
        "data: [DONE]\n",
      ]),
    );

    expect((await collect(openai().send(request()))).at(-1)).toEqual({
      kind: "finish",
      stopReason: "max_tokens",
    });
  });

  it("sends no num_predict when no output cap was requested", async () => {
    const fetchMock = stubFetch(streamingResponse(["data: [DONE]\n"]));

    await collect(openai().send(request()));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(4096);
  });
});

describe("HermesProvider message rendering", () => {
  it("renders a tool-calls-only assistant turn without a leading blank line", async () => {
    const fetchMock = stubFetch(
      streamingResponse([ollamaLine({ message: { content: "ok" } })]),
    );

    await collect(
      ollama().send(
        request({
          messages: [
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "notes.search", args: { q: "b" } }],
            },
          ],
        }),
      ),
    );

    const { messages } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(messages[1]).toEqual({
      role: "assistant",
      content:
        '<tool_call>{"name":"notes.search","arguments":{"q":"b"}}</tool_call>',
    });
  });

  it("omits num_predict from the ollama body when no cap is set", async () => {
    const fetchMock = stubFetch(
      streamingResponse([ollamaLine({ message: { content: "ok" } })]),
    );

    await collect(ollama().send(request()));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).options).toBeUndefined();
  });
});
