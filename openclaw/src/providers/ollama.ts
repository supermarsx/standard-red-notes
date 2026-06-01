import type { Provider, ProviderRequest, ProviderEvent } from "./types.js";

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaResponse {
  done: boolean;
  message?: {
    content?: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  };
  done_reason?: string;
}

/**
 * Minimal Ollama provider. Uses /api/chat with streaming. Ollama's tool
 * calling is best-effort and depends on the model; for unsupported models
 * the agent loop will simply never see tool-call events.
 */
export class OllamaProvider implements Provider {
  readonly id = "ollama";

  constructor(
    private readonly model: string,
    private readonly baseURL: string = "http://127.0.0.1:11434",
  ) {}

  async *send(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const messages: OllamaMessage[] = [
      { role: "system", content: req.system },
      ...req.messages.map((m) => ({
        role: m.role as OllamaMessage["role"],
        content: m.content,
        tool_calls: m.toolCalls?.map((tc) => ({
          function: {
            name: tc.name,
            arguments: (tc.args as Record<string, unknown>) ?? {},
          },
        })),
      })),
    ];

    const res = await fetch(`${this.baseURL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        tools: req.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })),
      }),
    });

    if (!res.ok || !res.body) {
      yield {
        kind: "error",
        message: `ollama: ${res.status} ${res.statusText}`,
      };
      yield { kind: "finish", stopReason: "error" };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let callIdx = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: OllamaResponse;
        try {
          parsed = JSON.parse(line) as OllamaResponse;
        } catch {
          continue;
        }

        if (parsed.message?.content) {
          yield { kind: "text-delta", delta: parsed.message.content };
        }

        for (const tc of parsed.message?.tool_calls ?? []) {
          yield {
            kind: "tool-call",
            id: `ollama_call_${callIdx++}`,
            name: tc.function.name,
            args: tc.function.arguments,
          };
        }

        if (parsed.done) {
          yield {
            kind: "finish",
            stopReason:
              parsed.done_reason === "length" ? "max_tokens" : "end_turn",
          };
          return;
        }
      }
    }
  }
}
