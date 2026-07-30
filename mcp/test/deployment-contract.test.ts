import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactDiagnosticMessage } from "../src/diagnostics.js";
import { assertSafeHttpBinding } from "../src/httpSecurity.js";

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
      /Empty or short values make\s+# the MCP process fail closed/,
    );
    expect(exampleEnvironment).toContain(
      "MUST be different from MCP_HTTP_TOKEN",
    );
    expect(exampleEnvironment).toContain(
      "File attachment and export tools are disabled while these roots are empty",
    );
  });

  it("renders the profiled Compose model when Docker Compose is available", () => {
    const version = spawnSync("docker", ["compose", "version"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    if (version.status !== 0) {
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
        windowsHide: true,
      },
    );
    if (rendered.status !== 0) {
      throw new Error(
        `docker compose config failed: ${rendered.stderr.trim()}`,
      );
    }
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
        `${secrets.join(" ")} Bearer header-secret ${"x".repeat(2_000)}`,
      ),
      secrets,
    );

    for (const secret of [...secrets, "header-secret"]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("Bearer <redacted>");
    expect(output.length).toBeLessThanOrEqual(1_000);
  });
});
