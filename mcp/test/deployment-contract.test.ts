import { readFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactDiagnosticMessage } from "../src/diagnostics.js";
import {
  assertDistinctHttpCredentials,
  assertSafeHttpBinding,
} from "../src/httpSecurity.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const compose = readFileSync(
  resolve(repositoryRoot, "docker-compose.yml"),
  "utf8",
);
const exampleEnvironment = readFileSync(
  resolve(repositoryRoot, ".env.example"),
  "utf8",
);
const dockerComposeProbeTimeoutMs = 10_000;
const dockerComposeRenderTimeoutMs = 15_000;
const dockerComposeContractTestTimeoutMs =
  dockerComposeProbeTimeoutMs + dockerComposeRenderTimeoutMs + 5_000;

type ComposeCommandResult = Pick<
  SpawnSyncReturns<string>,
  "error" | "signal" | "status" | "stderr"
>;

function requireCompletedCommand(
  result: ComposeCommandResult,
  operation: string,
): number {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new Error(
      `${operation} failed to complete${code ? ` (${code})` : ""}: ${result.error.message}`,
    );
  }
  if (result.status === null) {
    throw new Error(
      `${operation} failed to complete with status null${result.signal ? ` after signal ${result.signal}` : ""}`,
    );
  }
  return result.status;
}

function composeCapability(
  result: ComposeCommandResult,
): "available" | "unavailable" {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return "unavailable";
  }
  return requireCompletedCommand(result, "docker compose capability probe") ===
    0
    ? "available"
    : "unavailable";
}

function serviceBlock(name: string): string {
  const header = `\n  ${name}:\n`;
  const start = compose.indexOf(header);
  if (start < 0) throw new Error(`missing Compose service: ${name}`);
  const bodyStart = start + header.length;
  const remaining = compose.slice(bodyStart);
  const nextService = remaining.search(/\n  [A-Za-z0-9_-]+:\n/);
  return nextService < 0 ? remaining : remaining.slice(0, nextService);
}

describe("MCP Compose deployment contract", () => {
  const mcp = serviceBlock("mcp");

  it("binds for container peers only with explicit authenticated remote opt-in", () => {
    expect(mcp).toContain("MCP_TRANSPORT: http");
    expect(mcp).toContain('MCP_HTTP_HOST: "0.0.0.0"');
    expect(mcp).toContain('MCP_HTTP_PORT: "3010"');
    expect(mcp).toContain('MCP_HTTP_ALLOW_REMOTE: "1"');
    expect(mcp).toContain("MCP_HTTP_TOKEN: ${MCP_HTTP_TOKEN:-}");
    expect(mcp).toMatch(/networks:\s+- standard-red-notes/);
    expect(mcp).not.toMatch(/^\s{4}ports:/m);

    expect(() =>
      assertSafeHttpBinding({
        host: "0.0.0.0",
        allowRemote: true,
        token: undefined,
      }),
    ).toThrow(/MCP_HTTP_TOKEN/);
    expect(() =>
      assertSafeHttpBinding({
        host: "0.0.0.0",
        allowRemote: true,
        token: "short",
      }),
    ).toThrow(/at least 32 bytes/);
    expect(() =>
      assertSafeHttpBinding({
        host: "0.0.0.0",
        allowRemote: true,
        token: "x".repeat(32),
      }),
    ).not.toThrow();
    expect(() =>
      assertDistinctHttpCredentials({
        httpToken: "same-secret",
        accountToken: "same-secret",
        password: undefined,
      }),
    ).toThrow(/must be distinct/);
  });

  it("passes scoped account auth, bounded HTTP settings, and confinement controls", () => {
    for (const variable of [
      "STANDARD_RED_NOTES_MCP_TOKEN",
      "STANDARD_RED_NOTES_FILE_ROOTS",
      "STANDARD_RED_NOTES_EXPORT_ROOTS",
      "STANDARD_RED_NOTES_MAX_ATTACHMENT_BYTES",
      "STANDARD_RED_NOTES_MAX_EXPORT_BYTES",
      "MCP_HTTP_MAX_BODY_BYTES",
      "MCP_HTTP_MAX_SESSIONS",
      "MCP_HTTP_SESSION_IDLE_MS",
      "MCP_HTTP_BODY_TIMEOUT_MS",
      "MCP_HTTP_REQUEST_TIMEOUT_MS",
    ]) {
      expect(mcp, variable).toContain(`${variable}: \${${variable}:-`);
      expect(exampleEnvironment, variable).toContain(`# ${variable}=`);
    }
    expect(exampleEnvironment).toMatch(
      /Empty or short values make the MCP process fail\s+# closed/,
    );
    expect(exampleEnvironment).toContain(
      "MUST be different from MCP_HTTP_TOKEN",
    );
    expect(exampleEnvironment).toContain(
      "File attachment and export tools are disabled while these roots are empty",
    );
  });

  it(
    "renders the profiled Compose model when Docker Compose is available",
    () => {
      const version = spawnSync("docker", ["compose", "version"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: dockerComposeProbeTimeoutMs,
        windowsHide: true,
      });
      if (composeCapability(version) === "unavailable") {
        return;
      }
      const rendered = spawnSync(
        "docker",
        [
          "compose",
          "--env-file",
          ".env.example",
          "--profile",
          "mcp",
          "config",
          "--quiet",
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          timeout: dockerComposeRenderTimeoutMs,
          windowsHide: true,
        },
      );
      const renderedStatus = requireCompletedCommand(
        rendered,
        "docker compose config",
      );
      if (renderedStatus !== 0) {
        const diagnostic =
          rendered.stderr.trim() || "unknown Docker Compose error";
        throw new Error(`docker compose config failed: ${diagnostic}`);
      }
    },
    dockerComposeContractTestTimeoutMs,
  );

  it("treats only confirmed command unavailability as an unavailable Compose capability", () => {
    const missingCommand = Object.assign(new Error("spawn docker ENOENT"), {
      code: "ENOENT",
    });

    expect(
      composeCapability({
        error: missingCommand,
        signal: null,
        status: null,
        stderr: "",
      }),
    ).toBe("unavailable");
    expect(
      composeCapability({ signal: null, status: 1, stderr: "not available" }),
    ).toBe("unavailable");
  });

  it("fails explicitly when Compose commands time out or lose their exit status", () => {
    const timedOut = Object.assign(new Error("spawnSync docker ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });

    expect(() =>
      composeCapability({
        error: timedOut,
        signal: "SIGTERM",
        status: null,
        stderr: "",
      }),
    ).toThrow(/ETIMEDOUT/);
    expect(() =>
      composeCapability({
        signal: "SIGTERM",
        status: null,
        stderr: "",
      }),
    ).toThrow(/status null after signal SIGTERM/);
    expect(() =>
      requireCompletedCommand(
        {
          error: timedOut,
          signal: "SIGTERM",
          status: null,
          stderr: "",
        },
        "docker compose config",
      ),
    ).toThrow(/docker compose config failed to complete \(ETIMEDOUT\)/);
  });
});

describe("MCP deployment diagnostics", () => {
  it("redacts every configured credential and bounds untrusted errors", () => {
    const secrets = [
      "account-token-secret",
      "password-secret",
      "123456",
      "http-bearer-secret",
      "person@example.test",
    ];
    const output = redactDiagnosticMessage(
      new Error(
        `${secrets.join(" ")} Bearer header-secret Authorization: Basic dXNlcjpwYXNz X-Api-Key: unknown-secret ${"x".repeat(2_000)}`,
      ),
      secrets,
    );

    for (const secret of [
      ...secrets,
      "header-secret",
      "dXNlcjpwYXNz",
      "unknown-secret",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("Bearer <redacted>");
    expect(output.length).toBeLessThanOrEqual(1_000);
  });

  it("does not over-redact ordinary authentication prose", () => {
    const prose =
      "Basic authentication is supported; bearer capacity is an unrelated phrase.";
    expect(redactDiagnosticMessage(prose, [])).toBe(prose);
  });
});
