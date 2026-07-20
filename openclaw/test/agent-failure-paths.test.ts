import { describe, expect, it } from "vitest";
import { run } from "../src/core/agent.js";
import type { McpSession } from "../src/mcp/session.js";
import type {
  Provider,
  ProviderEvent,
  ProviderRequest,
} from "../src/providers/types.js";

/**
 * Like MockProvider, but records the requests it was sent so the tests can
 * assert what the agent actually put in front of the model. MockProvider lives
 * in src/ and is not ours to change.
 */
class RecordingProvider implements Provider {
  readonly id = "mock";
  readonly requests: ProviderRequest[] = [];
  private cursor = 0;

  constructor(private readonly script: ProviderEvent[][]) {}

  get lastRequest(): ProviderRequest | undefined {
    return this.requests.at(-1);
  }

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.script[this.cursor++];
    if (!turn) {
      yield { kind: "finish", stopReason: "end_turn" };
      return;
    }
    for (const ev of turn) yield ev;
  }
}

/**
 * The happy paths live in agent.test.ts. These cover what the loop does when
 * things go wrong: a provider error mid-stream, a tool that throws, and a
 * provider that asks to stop without dispatching tools.
 */

function fakeSession(
  call: (name: string, args: unknown) => Promise<unknown>,
): McpSession {
  return {
    tools: () => [
      {
        name: "notes.search",
        description: "search notes",
        inputSchema: { type: "object" },
        scope: "read",
      },
    ],
    call,
    start: async () => undefined,
    close: async () => undefined,
    refreshCatalog: async () => undefined,
  } as unknown as McpSession;
}

const okSession = () => fakeSession(async () => ({ hits: [] }));

describe("agent provider errors", () => {
  it("abandons the run and reports stopReason=error", async () => {
    const provider = new RecordingProvider([
      [
        { kind: "text-delta", delta: "partial " },
        { kind: "error", message: "upstream 500" },
        { kind: "text-delta", delta: "never reached" },
      ],
    ]);

    const result = await run([{ role: "user", content: "hi" }], {
      provider,
      session: okSession(),
    });

    expect(result.stopReason).toBe("error");
    expect(result.steps).toBe(1);
    // Text streamed before the error is kept; anything after it is not.
    expect(result.finalText).toBe("partial ");
  });

  it("stops streaming to the caller once the provider errors", async () => {
    const seen: string[] = [];
    const provider = new RecordingProvider([
      [
        { kind: "text-delta", delta: "one" },
        { kind: "error", message: "boom" },
        { kind: "text-delta", delta: "two" },
      ],
    ]);

    await run([{ role: "user", content: "hi" }], {
      provider,
      session: okSession(),
      onTextDelta: (c) => seen.push(c),
    });

    expect(seen).toEqual(["one"]);
  });
});

describe("agent tool failures", () => {
  it("feeds a thrown tool error back to the model instead of aborting", async () => {
    const provider = new RecordingProvider([
      [
        { kind: "tool-call", id: "c1", name: "notes.search", args: {} },
        { kind: "finish", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", delta: "I could not search." },
        { kind: "finish", stopReason: "end_turn" },
      ],
    ]);
    const session = fakeSession(async () => {
      throw new Error("tool exploded");
    });

    const result = await run([{ role: "user", content: "find" }], {
      provider,
      session,
    });

    // The loop survives and gets a second turn out of the model.
    expect(result.stopReason).toBe("end_turn");
    expect(result.steps).toBe(2);
    expect(result.finalText).toBe("I could not search.");
    // The failure was reported to the model as a tool message.
    const toolTurn = provider.lastRequest?.messages.find(
      (m) => m.role === "tool",
    );
    expect(toolTurn?.content).toContain("error: Error: tool exploded");
  });

  it("serialises a non-string tool result as JSON for the model", async () => {
    const provider = new RecordingProvider([
      [
        { kind: "tool-call", id: "c1", name: "notes.search", args: {} },
        { kind: "finish", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", delta: "done" },
        { kind: "finish", stopReason: "end_turn" },
      ],
    ]);
    const session = fakeSession(async () => ({ hits: ["a"] }));

    await run([{ role: "user", content: "find" }], { provider, session });

    const toolTurn = provider.lastRequest?.messages.find(
      (m) => m.role === "tool",
    );
    expect(toolTurn?.content).toBe(JSON.stringify({ hits: ["a"] }));
  });

  it("passes a string tool result through unquoted", async () => {
    const provider = new RecordingProvider([
      [
        { kind: "tool-call", id: "c1", name: "notes.search", args: {} },
        { kind: "finish", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", delta: "done" },
        { kind: "finish", stopReason: "end_turn" },
      ],
    ]);
    const session = fakeSession(async () => "plain text result");

    await run([{ role: "user", content: "find" }], { provider, session });

    const toolTurn = provider.lastRequest?.messages.find(
      (m) => m.role === "tool",
    );
    expect(toolTurn?.content).toBe("plain text result");
  });
});

describe("agent stop handling", () => {
  it("breaks out of the loop when the provider stops after dispatching tools", async () => {
    // stopReason is NOT tool_use, so the loop must not run another step even
    // though tools were called; it falls through to the summary turn.
    const provider = new RecordingProvider([
      [
        { kind: "tool-call", id: "c1", name: "notes.search", args: {} },
        { kind: "finish", stopReason: "max_tokens" },
      ],
      [
        { kind: "text-delta", delta: "summary after the cap" },
        { kind: "finish", stopReason: "end_turn" },
      ],
    ]);

    const result = await run([{ role: "user", content: "find" }], {
      provider,
      session: okSession(),
      maxSteps: 5,
    });

    expect(result.stopReason).toBe("max_steps");
    expect(result.finalText).toBe("summary after the cap");
    // The summary turn is sent with no tools available.
    expect(provider.lastRequest?.tools).toEqual([]);
  });

  it("streams the forced summary turn to the caller too", async () => {
    const seen: string[] = [];
    const provider = new RecordingProvider([
      [
        { kind: "tool-call", id: "c1", name: "notes.search", args: {} },
        { kind: "finish", stopReason: "stop" },
      ],
      [
        { kind: "text-delta", delta: "wrapped up" },
        { kind: "finish", stopReason: "end_turn" },
      ],
    ]);

    await run([{ role: "user", content: "find" }], {
      provider,
      session: okSession(),
      maxSteps: 3,
      onTextDelta: (c) => seen.push(c),
    });

    expect(seen).toContain("wrapped up");
  });
});

describe("agent tool descriptors", () => {
  it("prefixes each tool description with its scope for the model", async () => {
    const provider = new RecordingProvider([
      [
        { kind: "text-delta", delta: "hi" },
        { kind: "finish", stopReason: "end_turn" },
      ],
    ]);

    await run([{ role: "user", content: "hi" }], {
      provider,
      session: okSession(),
    });

    expect(provider.lastRequest?.tools?.[0]).toMatchObject({
      name: "notes.search",
      description: "[scope=read] search notes",
    });
  });
});

describe("agent prompt and step defaults", () => {
  it("uses a caller-supplied system prompt in place of the built-in one", async () => {
    const provider = new RecordingProvider([
      [
        { kind: "text-delta", delta: "hi" },
        { kind: "finish", stopReason: "end_turn" },
      ],
    ]);

    await run([{ role: "user", content: "hi" }], {
      provider,
      session: okSession(),
      systemPrompt: "CUSTOM PROMPT",
    });

    expect(provider.lastRequest?.system).toBe("CUSTOM PROMPT");
  });

  it("appends the step-cap instruction to the caller's prompt on the summary turn", async () => {
    const provider = new RecordingProvider([
      [
        { kind: "tool-call", id: "c1", name: "notes.search", args: {} },
        { kind: "finish", stopReason: "stop" },
      ],
      [
        { kind: "text-delta", delta: "done" },
        { kind: "finish", stopReason: "end_turn" },
      ],
    ]);

    await run([{ role: "user", content: "hi" }], {
      provider,
      session: okSession(),
      systemPrompt: "CUSTOM PROMPT",
      maxSteps: 2,
    });

    expect(provider.lastRequest?.system).toContain("CUSTOM PROMPT");
    expect(provider.lastRequest?.system).toContain("reached the step cap");
  });
});

describe("agent stream robustness", () => {
  it("ignores provider events it does not recognise", async () => {
    const provider = new RecordingProvider([
      [
        { kind: "text-delta", delta: "hi" },
        { kind: "heartbeat" } as unknown as ProviderEvent,
        { kind: "finish", stopReason: "end_turn" },
      ],
    ]);

    const result = await run([{ role: "user", content: "hi" }], {
      provider,
      session: okSession(),
    });

    expect(result.finalText).toBe("hi");
    expect(result.stopReason).toBe("end_turn");
  });
});
