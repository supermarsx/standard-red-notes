# Open Claw — Personal Assistant Agent Plan

Open Claw is the personal assistant agent that sits on top of the Standard Red
Notes MCP bridge. The user's notes, files, and tags are the primary memory
substrate; the agent's job is to read, search, draft, and curate against that
substrate on the user's behalf.

This document is the design spec. The implementation slices at the bottom map
to the tracked tasks. Read alongside [MCP Support Plan](./MCP_SUPPORT_PLAN.md);
Open Claw is one of the first concrete consumers of the local-client MCP.

## Goals

- A self-hostable, single-user assistant the user owns end to end — no SaaS
  account required, no telemetry leaving the host.
- Notes-aware. Open Claw must treat the user's notes as durable long-term
  memory: search them before answering, write back into them when the user
  asks, never silently mutate them.
- Provider-agnostic. The reasoning model is pluggable: hosted Anthropic
  Claude, OpenAI, AWS Bedrock, Vertex AI, or a local Ollama server. The
  rest of the agent does not know which one is in use.
- Composable. Open Claw is a node workspace package; other front ends (TUI,
  web, mobile, the desktop tray) can embed it without rewriting the agent
  loop.
- Fork-friendly. No upstream Standard Notes service is called. The MCP
  bridge gates every server interaction.

## Non-goals (this iteration)

- Multi-user agents or shared session state.
- Fine-tuned / RAG-trained models. Retrieval happens via MCP `notes.search`
  + structured re-rank, not via a vector store this slice.
- A general-purpose tool runtime. Open Claw only calls MCP tools and a small
  internal toolbox (timer, math, fs.read on user-approved paths). No
  arbitrary shell.
- Replacing the existing Standard Notes editors. Note _editing_ flows back
  through the app via MCP `notes.update`.

## Architecture

```
+--------------------+      +--------------------+      +--------------+
|   user surface     | ---> |   Open Claw core   | ---> |  MCP bridge  |
|  (CLI / TUI / web) |      |  (agent loop, LLM) |      |   (mcp/)     |
+--------------------+      +----+-----+---------+      +------+-------+
                                 |     |                       |
                                 |     v                       v
                                 |   provider          standard-red-notes
                                 |   (Anthropic /            server +
                                 |    OpenAI /              local app
                                 |    Ollama / ...)         (decrypted)
                                 |
                                 v
                          local sandbox tools
                          (clock, math, allowlisted fs read)
```

### Package layout

```
openclaw/
  package.json                      # @standard-red-notes/openclaw
  tsconfig.json
  src/
    index.ts                        # CLI entry: `openclaw <command>`
    cli/
      chat.ts                       # interactive REPL
      ask.ts                        # one-shot question -> stdout
      doctor.ts                     # diagnose mcp, provider, config
    core/
      agent.ts                      # agent loop (plan / act / observe)
      tools.ts                      # MCP tool catalog + local sandbox tools
      prompts.ts                    # system prompts, MCP tool-call schema
      memory.ts                     # short-term scratchpad + long-term via notes
    providers/
      types.ts                      # Provider interface
      anthropic.ts                  # Claude (default)
      openai.ts                     # OpenAI + OpenAI-compatible endpoints
      ollama.ts                     # local Ollama
      mock.ts                       # deterministic provider for tests
    mcp/
      client.ts                     # MCP stdio + Streamable HTTP client
      session.ts                    # tool listing, schema cache, auth
    config/
      schema.ts                     # zod schema for the config file
      load.ts                       # discover + parse ~/.openclaw/config.toml
    util/
      log.ts                        # structured logging (no secrets)
      redact.ts                     # redact notes content from logs
  test/                             # vitest, deterministic provider
```

### Agent loop

A bounded ReAct-style loop. One iteration:

1. Compose the model prompt: system message + recent user turns + scratchpad
   + the MCP tool catalog (advertised by the connected bridge).
2. Call the provider with structured-output mode that the provider supports
   (Anthropic tool use, OpenAI function calling, Ollama JSON mode).
3. If the response contains a tool call, execute it via the MCP session,
   append the result to the scratchpad, and continue.
4. If the response is a final user message, return it.
5. Cap at `max_steps` (default 8) to bound runaway loops. After the cap,
   force a model summary turn ("answer with what you have").

### Provider interface

```ts
export interface Provider {
  id: string
  send(req: {
    system: string
    messages: ChatMessage[]
    tools: ToolDescriptor[]
    maxOutputTokens?: number
    stop?: string[]
  }): AsyncIterable<ProviderEvent>
}
```

`ProviderEvent` is one of `{ kind: 'text-delta', delta: string }`,
`{ kind: 'tool-call', id, name, args }`, `{ kind: 'finish', stopReason }`.
This is the same shape the streaming Anthropic / OpenAI SDKs already emit,
so each provider adapter is a thin translation layer.

### MCP session

The CLI auto-spawns the existing `mcp/` stdio bridge for local-client tools.
Server-side tools come from a separately configured remote MCP endpoint
(Streamable HTTP, once the server MCP slice is built). Sessions:

- Discover tools via `tools/list`.
- Cache tool schemas; rebuild on `tools/list_changed`.
- Enforce a per-tool scope check from the config before dispatch
  (`read`, `write`, `files`, `admin`, `export`).
- Log every tool name + redacted arguments + redacted result summary to the
  local audit file (`~/.openclaw/audit.log`).

### Configuration

`~/.openclaw/config.toml` (override with `$OPENCLAW_CONFIG`):

```toml
[provider]
type = "anthropic"            # anthropic | openai | ollama | mock
model = "claude-opus-4-7"
# anthropic key from env: ANTHROPIC_API_KEY
# openai base url override: provider.base_url

[mcp.local]
command = "node"
args = ["mcp/dist/index.js"]
scopes = ["read"]             # adds "write" / "files" / "export" / "admin"

[agent]
max_steps = 8
scratchpad_kb = 64
audit_file = "~/.openclaw/audit.log"

[security]
allow_filesystem_paths = []   # local sandbox fs.read allowlist
```

A bad config exits with a one-line error and a pointer to `openclaw doctor`.

### Security & privacy

- No plaintext notes are logged. The audit log records tool name, scope,
  duration, success/failure, and a content hash; the body is replaced with
  `<note:uuid …N chars>` markers via `util/redact`.
- The provider receives whatever tool results the agent passes through.
  When using a hosted provider, the user's notes content does cross the
  network — this is unavoidable for LLM reasoning. Surface this clearly
  in `openclaw doctor` and in first-run output.
- For users who do not want notes to leave their machine, the ollama
  provider is the supported path.
- API keys come from environment variables, never from config.toml.
- The CLI refuses to start if `config.toml` is world-readable on POSIX.

## Slicing

Each slice is a separate commit and maps to an implementation task.

1. **Skeleton + CLI scaffold.** Workspace package, `openclaw doctor` and
   `openclaw ask --provider mock`, no MCP yet. Mock provider so tests run
   without keys.
2. **MCP client + Anthropic provider.** `openclaw ask` actually calls
   Claude, lists the bridge's tools, no tool calls executed yet (read-only
   probe).
3. **Tool-calling loop.** Wire up the agent loop. First end-to-end demo:
   `openclaw ask "what notes mention budget"` triggers `notes.search`.
4. **CRUD tools in the MCP bridge.** Land `notes.list`, `notes.read`,
   `notes.search`, `notes.create`, `notes.update`, `notes.delete` in
   `mcp/`. Each tool's scope is enforced before dispatch.
5. **`openclaw chat` REPL.** Multi-turn with scratchpad persistence per
   session.
6. **Additional providers.** OpenAI and Ollama adapters with shared tests.
7. **Server-side MCP consumption.** Once the server MCP slice lands, point
   a second remote session at it for status/health questions.

## Decisions made up front

- **TypeScript only**, no rust/go binaries in this slice — keeps the
  workspace single-toolchain.
- **Vitest** for tests instead of Jest to avoid the ts-jest/jest-30 PnP
  peer-dep dance the other workspaces hit. Each provider has a contract
  test driven by the mock provider.
- **No vector store yet.** Search delegates to `notes.search` which is
  already keyword + tag based in the existing client.
- **CLI first, web later.** The agent loop must run headless so the same
  binary can later be embedded by the desktop tray, the web app's
  "ask Open Claw" panel, or a future TUI.

## Open questions (decide before slice 4)

- Should `notes.update` always create a revision (Standard Notes already
  tracks revisions), and if so should Open Claw label the revision with
  the model id + step trace for later audit?
- How should the local MCP scope prompt look — single confirm on first
  use per session, every call, or scoped grants written back to the
  config?
- Do we expose Open Claw as an MCP server itself so other agents can
  delegate to it? Out of scope for this slice but worth flagging.
