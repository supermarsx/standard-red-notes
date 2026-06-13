import type {
  Provider,
  ProviderRequest,
  ProviderEvent,
  ChatMessage,
} from "../types.js";
import { buildHermesSystemPrompt } from "./prompt.js";
import { HermesParser, type HermesEvent } from "./parser.js";

export type HermesTransport = "openai" | "ollama";

export interface HermesOptions {
  transport?: HermesTransport;
  /** API key for OpenAI-compatible endpoints (LM Studio, vLLM, etc.). */
  apiKey?: string;
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * Provider for local LLMs using the Nous-Hermes tool-calling convention.
 *
 * Unlike the native ollama/openai providers, it never sends the `tools`
 * parameter. Tool schemas are injected into the system prompt via
 * {@link buildHermesSystemPrompt}, model output is streamed through
 * {@link HermesParser} to extract `<tool_call>` blocks, and tool RESULT
 * messages are rendered back as `<tool_response>...</tool_response>` text so
 * multi-step agent loops work against models that have no native tool channel.
 */
export class HermesProvider implements Provider {
  readonly id = "hermes";

  constructor(
    private readonly model: string,
    private readonly baseURL: string = "http://127.0.0.1:11434",
    private readonly transport: HermesTransport = "ollama",
    private readonly apiKey?: string,
  ) {}

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const system = buildHermesSystemPrompt(req.system, req.tools);
    const messages: WireMessage[] = [
      { role: "system", content: system },
      ...req.messages.map((m) => this.renderMessage(m)),
    ];

    const parser = new HermesParser();
    let callIdx = 0;
    let sawToolCall = false;
    let lengthCapped = false;

    // Translate parser events into ProviderEvents, tracking tool-call state.
    const emit = (events: HermesEvent[]): ProviderEvent[] => {
      const out: ProviderEvent[] = [];
      for (const ev of events) {
        if (ev.kind === "text") {
          if (ev.text) out.push({ kind: "text-delta", delta: ev.text });
        } else {
          sawToolCall = true;
          out.push({
            kind: "tool-call",
            id: `hermes_call_${callIdx++}`,
            name: ev.name,
            args: ev.args,
          });
        }
      }
      return out;
    };

    try {
      if (this.transport === "ollama") {
        for await (const piece of this.streamOllama(messages, req)) {
          if (piece.length) lengthCapped = piece.length;
          if (piece.content) yield* emit(parser.push(piece.content));
        }
      } else {
        for await (const piece of this.streamOpenAI(messages, req)) {
          if (piece.length) lengthCapped = piece.length;
          if (piece.content) yield* emit(parser.push(piece.content));
        }
      }
      // Drain any buffered prose / dangling tag.
      yield* emit(parser.flush());
    } catch (err) {
      yield { kind: "error", message: `hermes: ${String(err)}` };
      yield { kind: "finish", stopReason: "error" };
      return;
    }

    yield {
      kind: "finish",
      stopReason: sawToolCall
        ? "tool_use"
        : lengthCapped
          ? "max_tokens"
          : "end_turn",
    };
  }

  /** Map an agent ChatMessage onto a flat wire message for a chat endpoint. */
  private renderMessage(m: ChatMessage): WireMessage {
    if (m.role === "tool") {
      // Feed results back as Hermes tool_response text.
      const payload = wrapToolResponse(m);
      return { role: "user", content: payload };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      // Re-render the assistant's prior tool calls as <tool_call> text so the
      // conversation transcript stays consistent with what the model emits.
      const calls = m.toolCalls
        .map(
          (tc) =>
            `<tool_call>${JSON.stringify({ name: tc.name, arguments: tc.args })}</tool_call>`,
        )
        .join("\n");
      const content = m.content ? `${m.content}\n${calls}` : calls;
      return { role: "assistant", content };
    }
    return {
      role: m.role as WireMessage["role"],
      content: m.content,
    };
  }

  private async *streamOllama(
    messages: WireMessage[],
    req: ProviderRequest,
  ): AsyncIterable<{ content?: string; length?: boolean }> {
    const res = await fetch(`${this.baseURL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        options: req.maxOutputTokens
          ? { num_predict: req.maxOutputTokens }
          : undefined,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: {
          message?: { content?: string };
          done?: boolean;
          done_reason?: string;
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        yield {
          content: parsed.message?.content,
          length: parsed.done_reason === "length",
        };
      }
    }
  }

  private async *streamOpenAI(
    messages: WireMessage[],
    req: ProviderRequest,
  ): AsyncIterable<{ content?: string; length?: boolean }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: req.maxOutputTokens ?? 4096,
        stop: req.stop,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        let parsed: {
          choices?: Array<{
            delta?: { content?: string };
            finish_reason?: string | null;
          }>;
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        yield {
          content: choice.delta?.content ?? undefined,
          length: choice.finish_reason === "length",
        };
      }
    }
  }
}

/** Render a tool-result message as Hermes `<tool_response>` text. */
function wrapToolResponse(m: ChatMessage): string {
  // Keep the raw content if it is already JSON; otherwise wrap it as an object
  // so the model always receives a JSON payload inside the tags.
  let inner = m.content;
  try {
    JSON.parse(m.content);
  } catch {
    inner = JSON.stringify({ result: m.content });
  }
  return `<tool_response>${inner}</tool_response>`;
}
