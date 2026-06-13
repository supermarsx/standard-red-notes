import { describe, it, expect } from "vitest";
import {
  HermesParser,
  parseHermes,
  type HermesEvent,
} from "../src/providers/hermes/parser.js";
import { buildHermesSystemPrompt } from "../src/providers/hermes/prompt.js";
import { run } from "../src/core/agent.js";
import { MockProvider } from "../src/providers/mock.js";
import type { ProviderEvent } from "../src/providers/types.js";
import type { McpSession } from "../src/mcp/session.js";

/** Drive the parser one streamed chunk at a time, then flush. */
function streamParse(chunks: string[]): HermesEvent[] {
  const p = new HermesParser();
  const out: HermesEvent[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.flush());
  return out;
}

const toolCalls = (evs: HermesEvent[]) =>
  evs.filter((e) => e.kind === "tool-call");
const text = (evs: HermesEvent[]) =>
  evs
    .filter((e): e is Extract<HermesEvent, { kind: "text" }> => e.kind === "text")
    .map((e) => e.text)
    .join("");

describe("HermesParser", () => {
  it("parses a single tool_call", () => {
    const evs = parseHermes(
      '<tool_call>{"name": "notes.search", "arguments": {"query": "budget"}}</tool_call>',
    );
    const calls = toolCalls(evs);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "tool-call",
      name: "notes.search",
      args: { query: "budget" },
    });
  });

  it("parses multiple tool_calls in one turn", () => {
    const evs = parseHermes(
      '<tool_call>{"name": "a", "arguments": {"x": 1}}</tool_call>' +
        'some prose between' +
        '<tool_call>{"name": "b", "arguments": {"y": 2}}</tool_call>',
    );
    const calls = toolCalls(evs);
    expect(calls.map((c) => c.kind === "tool-call" && c.name)).toEqual([
      "a",
      "b",
    ]);
    expect(text(evs)).toContain("some prose between");
  });

  it("handles tags split across streamed chunks", () => {
    const evs = streamParse([
      "Let me look. <tool_",
      'call>{"name": "noBudget',
      '", "arguments": {"q": "x"}}</tool',
      "_call> done",
    ]);
    const calls = toolCalls(evs);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "noBudget", args: { q: "x" } });
    expect(text(evs)).toContain("Let me look.");
    expect(text(evs)).toContain("done");
    // The split open tag must not leak into the prose.
    expect(text(evs)).not.toContain("tool_");
  });

  it("strips an optional ```json fence inside the tags", () => {
    const evs = parseHermes(
      '<tool_call>```json\n{"name": "f", "arguments": {"a": true}}\n```</tool_call>',
    );
    const calls = toolCalls(evs);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "f", args: { a: true } });
  });

  it("passes plain prose through with no calls", () => {
    const evs = parseHermes("Just a normal answer, no tools needed.");
    expect(toolCalls(evs)).toHaveLength(0);
    expect(text(evs)).toBe("Just a normal answer, no tools needed.");
  });

  it("recovers gracefully from malformed JSON without throwing", () => {
    const evs = parseHermes(
      '<tool_call>{not valid json}</tool_call>and more text',
    );
    expect(toolCalls(evs)).toHaveLength(0);
    // The malformed block is surfaced as text, never dropped.
    expect(text(evs)).toContain("{not valid json}");
    expect(text(evs)).toContain("and more text");
  });

  it("recovers an unterminated tool_call at end of stream", () => {
    const evs = streamParse([
      '<tool_call>{"name": "z", "arguments": {}}',
    ]);
    const calls = toolCalls(evs);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "z" });
  });

  it("defaults missing arguments to an empty object", () => {
    const evs = parseHermes('<tool_call>{"name": "noargs"}</tool_call>');
    const calls = toolCalls(evs);
    expect(calls[0]).toMatchObject({ name: "noargs", args: {} });
  });
});

describe("buildHermesSystemPrompt", () => {
  const tools = [
    {
      name: "notes.search",
      description: "search notes",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  ];

  it("injects tools as a JSON array inside <tools> tags", () => {
    const out = buildHermesSystemPrompt("You are helpful.", tools);
    expect(out).toContain("You are helpful.");
    expect(out).toContain("<tools>");
    expect(out).toContain("</tools>");
    expect(out).toContain('"name": "notes.search"');
    expect(out).toContain('"type": "function"');
    // The schema is nested under function.parameters per Hermes convention.
    const between = out.slice(
      out.lastIndexOf("<tools>") + "<tools>".length,
      out.lastIndexOf("</tools>"),
    );
    const parsed = JSON.parse(between.trim());
    expect(parsed[0].function.name).toBe("notes.search");
    expect(parsed[0].function.parameters).toEqual(tools[0].inputSchema);
  });

  it("documents the <tool_call> contract", () => {
    const out = buildHermesSystemPrompt("base", tools);
    expect(out).toContain("<tool_call>");
    expect(out).toContain("</tool_call>");
  });

  it("returns the base system unchanged when there are no tools", () => {
    expect(buildHermesSystemPrompt("only base", [])).toBe("only base");
  });
});

// Agent-style test: a MockProvider that replays Hermes-style text through the
// parser, proving the parser drives a full tool dispatch + summary loop.
function hermesMockTurns(rawTexts: string[]): ProviderEvent[][] {
  let callIdx = 0;
  return rawTexts.map((raw) => {
    const events: ProviderEvent[] = [];
    let sawTool = false;
    for (const ev of parseHermes(raw)) {
      if (ev.kind === "text") {
        if (ev.text) events.push({ kind: "text-delta", delta: ev.text });
      } else {
        sawTool = true;
        events.push({
          kind: "tool-call",
          id: `hermes_call_${callIdx++}`,
          name: ev.name,
          args: ev.args,
        });
      }
    }
    events.push({
      kind: "finish",
      stopReason: sawTool ? "tool_use" : "end_turn",
    });
    return events;
  });
}

function fakeSession(toolResult: unknown): McpSession {
  return {
    tools: () => [
      {
        name: "notes.search",
        description: "search notes",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        scope: "read",
      },
    ],
    call: async () => toolResult,
    start: async () => undefined,
    close: async () => undefined,
    refreshCatalog: async () => undefined,
  } as unknown as McpSession;
}

describe("agent loop with Hermes-style text", () => {
  it("dispatches a parsed tool_call then returns the summary", async () => {
    const provider = new MockProvider(
      hermesMockTurns([
        'Let me check. <tool_call>{"name": "notes.search", "arguments": {"query": "budget"}}</tool_call>',
        "You have one budget note.",
      ]),
    );
    const session = fakeSession({
      hits: [{ uuid: "u1", title: "Budget" }],
    });
    const result = await run([{ role: "user", content: "budget notes?" }], {
      provider,
      session,
    });
    expect(result.finalText).toBe("You have one budget note.");
    expect(result.steps).toBe(2);
    expect(result.stopReason).toBe("end_turn");
  });
});
