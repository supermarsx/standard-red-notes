import type {
  Provider,
  ChatMessage,
  AssistantToolCall,
  ToolDescriptor,
} from "../providers/types.js";
import type { McpSession } from "../mcp/session.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { log } from "../util/log.js";

export interface AgentOptions {
  provider: Provider;
  session: McpSession;
  maxSteps?: number;
  /** Override the default system prompt. */
  systemPrompt?: string;
  /** Stream final assistant text deltas to this writable (typically stdout). */
  onTextDelta?: (chunk: string) => void;
  /** Maximum UTF-8 bytes retained in model-visible history. */
  scratchpadBytes?: number;
}

export interface AgentResult {
  finalText: string;
  steps: number;
  stopReason: "end_turn" | "max_steps" | "error";
}

const TRUNCATION_MARKER = "\n<openclaw:truncated>";
const MAX_TOOL_CALLS_PER_STEP = 64;

function utf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function truncateText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  if (maxBytes <= markerBytes) {
    return Buffer.from(TRUNCATION_MARKER, "utf8")
      .subarray(0, maxBytes)
      .toString("utf8");
  }
  let prefix = Buffer.from(value, "utf8")
    .subarray(0, maxBytes - markerBytes)
    .toString("utf8");
  while (
    prefix.length > 0 &&
    Buffer.byteLength(prefix + TRUNCATION_MARKER, "utf8") > maxBytes
  ) {
    prefix = prefix.slice(0, -1);
  }
  return prefix + TRUNCATION_MARKER;
}

function appendBoundedText(
  current: string,
  chunk: string,
  maxBytes: number,
): string {
  if (current.endsWith(TRUNCATION_MARKER)) return current;
  return truncateText(current + chunk, maxBytes);
}

function boundedMessage(message: ChatMessage, maxBytes: number): ChatMessage {
  const copy: ChatMessage = {
    ...message,
    content: truncateText(message.content, Math.max(1, maxBytes)),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            args:
              utf8Bytes(call.args) > Math.floor(maxBytes / 2)
                ? "<openclaw:truncated-tool-args>"
                : call.args,
          })),
        }
      : {}),
  };
  while (copy.toolCalls?.length && utf8Bytes(copy) > maxBytes) {
    copy.toolCalls = copy.toolCalls.slice(1);
  }
  if (utf8Bytes(copy) > maxBytes) {
    copy.content = truncateText(
      copy.content,
      Math.max(1, Math.floor(maxBytes / 2)),
    );
  }
  return copy;
}

export function boundHistory(
  messages: readonly ChatMessage[],
  maxBytes: number,
): ChatMessage[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("scratchpad byte limit must be a positive integer");
  }
  if (maxBytes < utf8Bytes([])) return [];
  let kept: ChatMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    let bounded = boundedMessage(messages[index], maxBytes);
    let candidate = [bounded, ...kept];
    if (utf8Bytes(candidate) > maxBytes && kept.length === 0) {
      const empty = { ...bounded, content: "" };
      const contentBudget = Math.max(0, maxBytes - utf8Bytes([empty]));
      bounded = {
        ...bounded,
        content: truncateText(bounded.content, contentBudget),
      };
      candidate = [bounded];
    }
    if (utf8Bytes(candidate) > maxBytes) break;
    kept = candidate;
  }
  while (kept[0]?.role === "tool") {
    kept.shift();
  }
  return kept;
}

export async function run(
  messages: ChatMessage[],
  opts: AgentOptions,
): Promise<AgentResult> {
  const { provider, session } = opts;
  const maxSteps = opts.maxSteps ?? 8;
  const scratchpadBytes = opts.scratchpadBytes ?? 64 * 1024;
  const systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
  const tools = describeToolsForProvider(session.tools());

  let history: ChatMessage[] = boundHistory(messages, scratchpadBytes);
  let finalText = "";

  for (let step = 1; step <= maxSteps; step++) {
    log.debug("agent step", { step });
    let assistantText = "";
    const toolCalls: AssistantToolCall[] = [];
    let stopReason: "end_turn" | "max_tokens" | "tool_use" | "stop" | "error" =
      "end_turn";

    const stream = provider.send({
      system: systemPrompt,
      messages: boundHistory(history, scratchpadBytes),
      tools,
    });

    for await (const ev of stream) {
      if (ev.kind === "text-delta") {
        assistantText = appendBoundedText(
          assistantText,
          ev.delta,
          scratchpadBytes,
        );
        opts.onTextDelta?.(ev.delta);
      } else if (ev.kind === "tool-call") {
        const nextToolCall = {
          id: ev.id,
          name: ev.name,
          args: ev.args,
        };
        if (
          toolCalls.length >= MAX_TOOL_CALLS_PER_STEP ||
          utf8Bytes([...toolCalls, nextToolCall]) > scratchpadBytes
        ) {
          log.error("provider tool-call batch exceeded scratchpad limit", {
            count: toolCalls.length + 1,
          });
          return {
            finalText: assistantText,
            steps: step,
            stopReason: "error",
          };
        }
        toolCalls.push(nextToolCall);
      } else if (ev.kind === "finish") {
        stopReason = ev.stopReason;
      } else if (ev.kind === "error") {
        log.error("provider error", { message: ev.message });
        return { finalText: assistantText, steps: step, stopReason: "error" };
      }
    }

    if (toolCalls.length === 0) {
      finalText = assistantText;
      return { finalText, steps: step, stopReason: "end_turn" };
    }

    history.push({ role: "assistant", content: assistantText, toolCalls });

    for (const tc of toolCalls) {
      try {
        const result = await session.call(tc.name, tc.args);
        const serialized =
          typeof result === "string" ? result : JSON.stringify(result);
        history.push({
          role: "tool",
          content: truncateText(
            serialized,
            Math.max(1, Math.floor(scratchpadBytes / 2)),
          ),
          toolCallId: tc.id,
          name: tc.name,
        });
      } catch (err) {
        history.push({
          role: "tool",
          content: `error: ${String(err)}`,
          toolCallId: tc.id,
          name: tc.name,
        });
      }
    }
    history = boundHistory(history, scratchpadBytes);

    if (stopReason !== "tool_use") {
      // Provider said we should stop; obey unless we just dispatched tools.
      break;
    }
  }

  // Hit max_steps. Force one final summary turn with no tools.
  const summaryStream = provider.send({
    system:
      systemPrompt +
      "\n\nYou have reached the step cap. Answer with what you have.",
    messages: boundHistory(history, scratchpadBytes),
    tools: [],
  });
  for await (const ev of summaryStream) {
    if (ev.kind === "text-delta") {
      finalText = appendBoundedText(finalText, ev.delta, scratchpadBytes);
      opts.onTextDelta?.(ev.delta);
    }
  }
  return { finalText, steps: maxSteps, stopReason: "max_steps" };
}

function describeToolsForProvider(
  entries: ReturnType<McpSession["tools"]>,
): ToolDescriptor[] {
  return entries.map((t) => ({
    name: t.name,
    description: `[scope=${t.scope}] ${t.description}`,
    inputSchema: t.inputSchema,
  }));
}
