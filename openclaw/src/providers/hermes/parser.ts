/**
 * Streaming-tolerant parser for Nous-Hermes tool-call output.
 *
 * Hermes models emit tool calls as plain text inside `<tool_call>...</tool_call>`
 * tags, interleaved with normal prose. This parser is fed text deltas (which may
 * split tags across arbitrary chunk boundaries) and yields:
 *   - `{ kind: "text", text }`  for prose outside any tool_call block
 *   - `{ kind: "tool-call", name, args }` for each successfully parsed call
 *
 * It is pure and HTTP-independent so it can be unit tested in isolation.
 *
 * Contract:
 *   - Call `push(delta)` for each streamed chunk; collect yielded events.
 *   - Call `flush()` once the stream ends to drain any buffered prose and
 *     handle an unterminated tag gracefully.
 *   - Malformed JSON inside a tool_call is never thrown: the raw block is
 *     emitted as text instead so nothing is silently lost.
 */

const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";

export interface ParsedToolCall {
  name: string;
  args: unknown;
}

export type HermesEvent =
  | { kind: "text"; text: string }
  | { kind: "tool-call"; name: string; args: unknown };

export class HermesParser {
  /** Unconsumed text. May contain a partial open/close tag at its tail. */
  private buf = "";
  /** True while we are inside a <tool_call>...</tool_call> block. */
  private inTool = false;

  /** Feed a streamed chunk; returns any events that became complete. */
  push(delta: string): HermesEvent[] {
    this.buf += delta;
    return this.drain(false);
  }

  /** Signal end-of-stream; drains buffered prose and any dangling tag. */
  flush(): HermesEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): HermesEvent[] {
    const out: HermesEvent[] = [];

    // Loop until we cannot make progress without more input.
    for (;;) {
      if (!this.inTool) {
        const openIdx = this.buf.indexOf(OPEN_TAG);
        if (openIdx === -1) {
          // No complete open tag in the buffer. Emit text, but hold back a
          // tail that might be the start of a split open tag (unless final).
          const safe = final
            ? this.buf.length
            : this.buf.length - maxOverlap(this.buf, OPEN_TAG);
          if (safe > 0) {
            const text = this.buf.slice(0, safe);
            if (text) out.push({ kind: "text", text });
            this.buf = this.buf.slice(safe);
          }
          break;
        }
        // Emit prose preceding the open tag, then enter tool mode.
        const text = this.buf.slice(0, openIdx);
        if (text) out.push({ kind: "text", text });
        this.buf = this.buf.slice(openIdx + OPEN_TAG.length);
        this.inTool = true;
      } else {
        const closeIdx = this.buf.indexOf(CLOSE_TAG);
        if (closeIdx === -1) {
          if (final) {
            // Unterminated tool_call at end of stream: recover the inner text
            // as a best-effort call, else emit it back as prose.
            const inner = this.buf;
            this.buf = "";
            this.inTool = false;
            out.push(...this.finishToolBlock(inner));
          }
          // Otherwise wait for more input (need the closing tag).
          break;
        }
        const inner = this.buf.slice(0, closeIdx);
        this.buf = this.buf.slice(closeIdx + CLOSE_TAG.length);
        this.inTool = false;
        out.push(...this.finishToolBlock(inner));
      }
    }

    return out;
  }

  /** Parse the inner text of a tool_call block into an event. */
  private finishToolBlock(raw: string): HermesEvent[] {
    const json = stripFence(raw).trim();
    if (!json) return [];
    try {
      const parsed = JSON.parse(json) as { name?: unknown; arguments?: unknown };
      if (parsed && typeof parsed.name === "string") {
        return [
          {
            kind: "tool-call",
            name: parsed.name,
            args: parsed.arguments ?? {},
          },
        ];
      }
    } catch {
      // fall through to graceful text recovery
    }
    // Malformed / not a tool object: surface the original block as prose so
    // the content is never silently dropped, and never throw.
    return [{ kind: "text", text: `${OPEN_TAG}${raw}${CLOSE_TAG}` }];
  }
}

/**
 * Largest suffix of `buf` that is a proper prefix of `tag`. Used to hold back a
 * partial open tag straddling a chunk boundary.
 */
function maxOverlap(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (buf.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

/** Strip an optional ```json ... ``` (or bare ``` ... ```) fence. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence ? fence[1] : trimmed;
}

/**
 * Convenience helper: parse a complete (non-streamed) response string into
 * events in one shot.
 */
export function parseHermes(text: string): HermesEvent[] {
  const p = new HermesParser();
  return [...p.push(text), ...p.flush()];
}
