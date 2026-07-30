import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const token = "test-only-bearer-token-that-is-long-enough";
let child: ChildProcess | undefined;

beforeAll(() => {
  execFileSync(
    process.execPath,
    ["esbuild.config.mjs", "src/index.ts", "dist/index.cjs"],
    { cwd: packageDirectory, stdio: "pipe" },
  );
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child?.once("exit", () => resolve());
      setTimeout(resolve, 7_000).unref?.();
    });
  }
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve test port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function initializeBody(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mcp-http-test", version: "1.0.0" },
    },
  };
}

async function post(
  port: number,
  body: unknown,
  options: { authorize?: boolean; sessionId?: string } = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(options.authorize
        ? { authorization: `Bearer ${token}` }
        : {}),
      ...(options.sessionId
        ? { "mcp-session-id": options.sessionId }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

async function waitForReady(
  process: ChildProcess,
  port: number,
): Promise<() => string> {
  let diagnostics = "";
  process.stderr?.setEncoding("utf8");
  process.stderr?.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`MCP server did not start:\n${diagnostics}`)),
      10_000,
    );
    const poll = setInterval(() => {
      if (diagnostics.includes(`127.0.0.1:${port}`)) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 20);
    process.once("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(poll);
      reject(
        new Error(`MCP server exited ${String(code)}:\n${diagnostics}`),
      );
    });
  });
  return () => diagnostics;
}

test(
  "spawned HTTP bridge enforces auth, bounds state, reuses/deletes sessions, and shuts down with active SSE",
  async () => {
    const port = await reservePort();
    child = spawn(process.execPath, ["dist/index.cjs"], {
      cwd: packageDirectory,
      env: {
        ...process.env,
        MCP_TRANSPORT: "http",
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: String(port),
        MCP_HTTP_TOKEN: token,
        MCP_HTTP_MAX_SESSIONS: "1",
        MCP_HTTP_MAX_BODY_BYTES: "2048",
        MCP_HTTP_SESSION_IDLE_MS: "60000",
        STANDARD_RED_NOTES_MCP_TOKEN: "",
        STANDARD_RED_NOTES_EMAIL: "",
        STANDARD_RED_NOTES_PASSWORD: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const diagnostics = await waitForReady(child, port);
    expect(diagnostics()).toContain(
      `listening on 127.0.0.1:${port}`,
    );

    const unauthorized = await post(port, initializeBody(1));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

    const oversized = await post(
      port,
      { payload: "x".repeat(3_000) },
      { authorize: true },
    );
    expect(oversized.status).toBe(413);

    const initialized = await post(port, initializeBody(2), {
      authorize: true,
    });
    expect(initialized.status).toBe(200);
    const firstSession = initialized.headers.get("mcp-session-id");
    expect(firstSession).toBeTruthy();
    await expect(initialized.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { serverInfo: { name: "standard-red-notes" } },
    });

    const capped = await post(port, initializeBody(3), { authorize: true });
    expect(capped.status).toBe(503);

    const tools = await post(
      port,
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
      { authorize: true, sessionId: firstSession as string },
    );
    expect(tools.status).toBe(200);
    const toolsBody = (await tools.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(
      toolsBody.result?.tools?.some(
        (tool) => tool.name === "standard_red_notes_status",
      ),
    ).toBe(true);

    const deleted = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        "mcp-session-id": firstSession as string,
      },
    });
    expect([200, 204]).toContain(deleted.status);

    const expiredReuse = await post(
      port,
      { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
      { authorize: true, sessionId: firstSession as string },
    );
    expect(expiredReuse.status).toBe(404);

    const second = await post(port, initializeBody(6), { authorize: true });
    const secondSession = second.headers.get("mcp-session-id");
    expect(second.status).toBe(200);
    expect(secondSession).toBeTruthy();
    await second.body?.cancel();

    const streamAbort = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-session-id": secondSession as string,
      },
      signal: streamAbort.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      child?.once("exit", (code, signal) => resolve({ code, signal })),
    );
    const shutdownStarted = Date.now();
    child.kill("SIGTERM");
    const exit = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("MCP process did not shut down in 7s")),
          7_000,
        ),
      ),
    ]);
    streamAbort.abort();
    if (process.platform === "win32") {
      // Windows implements child.kill("SIGTERM") as forced termination, so
      // Node reports a signal rather than running the POSIX signal hook.
      expect(exit.signal).toBe("SIGTERM");
    } else {
      // POSIX exercises the bridge's actual graceful shutdown hook.
      expect(exit).toEqual({ code: 0, signal: null });
    }
    expect(Date.now() - shutdownStarted).toBeLessThan(7_000);
  },
  30_000,
);
