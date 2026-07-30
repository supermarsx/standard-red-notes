import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../dist/core/agent.js";
import { McpSession } from "../dist/mcp/session.js";
import { MockProvider } from "../dist/providers/mock.js";

const mcpEntry = fileURLToPath(
  new URL("../../mcp/dist/index.cjs", import.meta.url),
);
const OPERATION_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 7_000;

class RecordingMockProvider extends MockProvider {
  requests = [];

  send(request) {
    this.requests.push(structuredClone(request));
    return super.send(request);
  }
}

function withTimeout(label, operation, timeoutMs = OPERATION_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
}

async function main() {
  assert.ok(
    existsSync(mcpEntry),
    `built MCP entrypoint is missing: ${mcpEntry}`,
  );

  const audit = [];
  const stderr = [];
  const session = new McpSession({
    command: process.execPath,
    args: [mcpEntry],
    env: {
      MCP_TRANSPORT: "stdio",
      STANDARD_RED_NOTES_ALLOW_WRITES: "0",
      STANDARD_RED_NOTES_SERVER_URL: "http://127.0.0.1:1",
      STANDARD_RED_NOTES_SYNC_INTERVAL_MS: "0",
    },
    allowedScopes: ["read"],
    audit: (entry) => audit.push(entry),
    onStderr: (chunk) => stderr.push(chunk),
  });

  let childPid = null;
  let stage = "starting the MCP session";
  let failure;
  let failureStage;

  try {
    await withTimeout(stage, session.start());
    childPid = session.childPid();
    assert.ok(childPid, "MCP transport did not expose a spawned child PID");

    stage = "rejecting a duplicate session start";
    await assert.rejects(session.start(), /session already started/);
    assert.equal(session.childPid(), childPid);

    stage = "validating the live MCP catalog";
    const tools = session.tools().map((tool) => tool.name);
    assert.ok(tools.includes("standard_red_notes_status"));
    assert.ok(tools.includes("notes.search"));
    assert.ok(tools.includes("vaults.list"));
    assert.ok(!tools.includes("notes.create"));
    assert.ok(!tools.includes("vaults.create"));

    const provider = new RecordingMockProvider([
      [
        {
          kind: "tool-call",
          id: "status-call",
          name: "standard_red_notes_status",
          args: {},
        },
        { kind: "finish", stopReason: "tool_use" },
      ],
      [
        {
          kind: "text-delta",
          delta: "The local Standard Red Notes MCP bridge is ready.",
        },
        { kind: "finish", stopReason: "end_turn" },
      ],
    ]);

    stage = "running the OpenClaw agent loop";
    const result = await withTimeout(
      stage,
      run([{ role: "user", content: "Is my notes bridge ready?" }], {
        provider,
        session,
      }),
    );

    assert.deepEqual(result, {
      finalText: "The local Standard Red Notes MCP bridge is ready.",
      steps: 2,
      stopReason: "end_turn",
    });
    assert.equal(provider.requests.length, 2);
    assert.ok(
      provider.requests[0].tools.some(
        (tool) => tool.name === "standard_red_notes_status",
      ),
    );

    const toolMessage = provider.requests[1].messages.find(
      (message) =>
        message.role === "tool" && message.toolCallId === "status-call",
    );
    assert.ok(
      toolMessage,
      "real MCP tool result was not returned to the provider",
    );
    const payload = JSON.parse(toolMessage.content);
    assert.deepEqual(payload.structuredContent, {
      status: "ready",
      transport: "stdio",
      serverUrl: "http://127.0.0.1:1",
      writes: false,
      accountConfigured: false,
      signedIn: false,
      syncHealthy: false,
      consecutiveSyncFailures: 0,
      authorizationLost: false,
      tagScope: {
        restricted: false,
        enforcement: "client-side-advisory",
        cryptographic: false,
      },
    });
    assert.equal(payload.isError, undefined);

    assert.equal(audit.length, 1);
    assert.equal(audit[0].tool, "standard_red_notes_status");
    assert.equal(audit[0].scope, "read");
    assert.equal(audit[0].ok, true);
  } catch (error) {
    failure = error;
    failureStage = stage;
  } finally {
    stage = "closing the MCP session";
    childPid ??= session.childPid();
    try {
      await withTimeout(stage, session.close(), CLOSE_TIMEOUT_MS);
      assert.equal(session.childPid(), null);
      assert.deepEqual(session.tools(), []);
      await session.close();
      if (childPid) {
        assert.ok(
          await waitForExit(childPid),
          `MCP child process ${childPid} remained alive after close`,
        );
      }
    } catch (closeError) {
      if (childPid && isProcessAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
          await waitForExit(childPid);
        } catch {
          // Preserve both the original failure and the cleanup failure below.
        }
      }
      failure = failure
        ? new AggregateError([failure, closeError], "E2E and cleanup failed")
        : closeError;
      failureStage ??= stage;
    }
  }

  if (failure) {
    const serverOutput = stderr.join("").trim() || "<no stderr>";
    throw new Error(
      `OpenClaw live MCP E2E failed during ${failureStage ?? stage}.\n` +
        `MCP entry: ${mcpEntry}\n` +
        `MCP stderr:\n${serverOutput}`,
      { cause: failure },
    );
  }

  process.stdout.write("OpenClaw live MCP E2E passed.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  if (error instanceof Error && error.cause) {
    console.error("Caused by:", error.cause);
  }
  process.exitCode = 1;
});
