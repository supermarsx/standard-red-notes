import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { configSchema, providerSchema } from "../src/config/schema.js";
import { loadConfig } from "../src/config/load.js";

describe("providerSchema", () => {
  it("applies the documented per-provider model defaults", () => {
    expect(providerSchema.parse({ type: "anthropic" })).toMatchObject({
      model: "claude-opus-4-7",
    });
    expect(providerSchema.parse({ type: "openai" })).toMatchObject({
      model: "gpt-4o-mini",
    });
    expect(providerSchema.parse({ type: "ollama" })).toMatchObject({
      model: "llama3.1",
      base_url: "http://127.0.0.1:11434",
    });
  });

  it("defaults hermes to the ollama transport on the local port", () => {
    expect(providerSchema.parse({ type: "hermes" })).toEqual({
      type: "hermes",
      model: "hermes3",
      base_url: "http://127.0.0.1:11434",
      transport: "ollama",
    });
  });

  it("rejects a hermes transport outside the openai/ollama union", () => {
    expect(() =>
      providerSchema.parse({ type: "hermes", transport: "grpc" }),
    ).toThrow();
    expect(
      providerSchema.parse({ type: "hermes", transport: "openai" }),
    ).toMatchObject({ transport: "openai" });
  });

  it("rejects an unknown provider type", () => {
    expect(() => providerSchema.parse({ type: "llamafile" })).toThrow();
  });

  it("rejects a base_url that is not a URL", () => {
    expect(() =>
      providerSchema.parse({ type: "openai", base_url: "not a url" }),
    ).toThrow();
    expect(() =>
      providerSchema.parse({ type: "openai", base_url: "" }),
    ).toThrow();
    expect(
      providerSchema.parse({
        type: "openai",
        base_url: "https://api.example.test/v1",
      }),
    ).toMatchObject({ base_url: "https://api.example.test/v1" });
  });

  it("rejects a scheme-less host:port that `new URL` reads as a scheme", () => {
    // "localhost:1234" parses as the scheme `localhost:`, so it used to pass
    // validation and only fail later as an opaque fetch error.
    for (const base_url of [
      "localhost:1234",
      "127.0.0.1:11434",
      "example.test",
      "ftp://example.test",
      "file:///etc/hosts",
      "http://",
    ]) {
      expect(
        () => providerSchema.parse({ type: "openai", base_url }),
        base_url,
      ).toThrow();
    }
  });

  it("still accepts ports, IPv6 literals, paths and plain http", () => {
    for (const base_url of [
      "http://127.0.0.1:11434",
      "http://localhost:1234",
      "https://api.example.test/v1",
      "https://api.example.test:8443/v1/",
      "http://[::1]:11434",
      "http://my-ollama.internal",
    ]) {
      expect(
        providerSchema.parse({ type: "openai", base_url }),
        base_url,
      ).toMatchObject({ base_url });
    }
  });

  it("keeps mock scripts as a string array defaulting to empty", () => {
    expect(providerSchema.parse({ type: "mock" })).toEqual({
      type: "mock",
      script: [],
    });
    expect(() =>
      providerSchema.parse({ type: "mock", script: [1, 2] }),
    ).toThrow();
  });
});

describe("configSchema", () => {
  it("fills agent and security defaults when the section is present", () => {
    const cfg = configSchema.parse({
      provider: { type: "mock" },
      agent: {},
      security: {},
    });
    expect(cfg.agent).toEqual({
      max_steps: 8,
      scratchpad_kb: 64,
      audit_file: "~/.openclaw/audit.log",
    });
    expect(cfg.security).toEqual({ allow_filesystem_paths: [] });
    expect(cfg.mcp).toEqual({});
  });

  it("keeps explicit agent values and defaults only the rest", () => {
    const cfg = configSchema.parse({
      provider: { type: "mock" },
      agent: { max_steps: 2 },
    });
    expect(cfg.agent.max_steps).toBe(2);
    expect(cfg.agent.audit_file).toBe("~/.openclaw/audit.log");
  });

  // Regression: `.default({} as never)` handed the literal back unparsed, so
  // omitting [agent] / [security] yielded undefined fields, and cli/ask.ts
  // then called auditSink(cfg.agent.audit_file) with undefined and threw on
  // `file.startsWith`. The defaults must be applied when the section is absent.
  it("fills agent and security defaults when the section is absent", () => {
    const cfg = configSchema.parse({ provider: { type: "mock" } });
    expect(cfg.agent).toEqual({
      max_steps: 8,
      scratchpad_kb: 64,
      audit_file: "~/.openclaw/audit.log",
    });
    expect(cfg.security).toEqual({ allow_filesystem_paths: [] });
  });

  it("requires a provider", () => {
    expect(() => configSchema.parse({})).toThrow();
  });

  it("defaults local MCP to node running the bundled server with read scope", () => {
    const cfg = configSchema.parse({
      provider: { type: "mock" },
      mcp: { local: {} },
    });
    expect(cfg.mcp.local).toEqual({
      command: "node",
      args: ["mcp/dist/index.cjs"],
      scopes: ["read"],
    });
  });

  it("rejects a scope outside the known scope enum", () => {
    expect(() =>
      configSchema.parse({
        provider: { type: "mock" },
        mcp: { local: { scopes: ["read", "root"] } },
      }),
    ).toThrow();
    expect(
      configSchema.parse({
        provider: { type: "mock" },
        mcp: { local: { scopes: ["read", "write", "admin"] } },
      }).mcp.local?.scopes,
    ).toEqual(["read", "write", "admin"]);
  });

  it("requires a URL for remote MCP", () => {
    expect(() =>
      configSchema.parse({
        provider: { type: "mock" },
        mcp: { remote: { url: "not a url" } },
      }),
    ).toThrow();
    expect(() =>
      configSchema.parse({ provider: { type: "mock" }, mcp: { remote: {} } }),
    ).toThrow();
  });

  it("rejects non-positive or fractional agent limits", () => {
    for (const max_steps of [0, -1, 2.5]) {
      expect(() =>
        configSchema.parse({
          provider: { type: "mock" },
          agent: { max_steps },
        }),
      ).toThrow();
    }
    expect(
      configSchema.parse({
        provider: { type: "mock" },
        agent: { max_steps: 3 },
      }).agent.max_steps,
    ).toBe(3);
  });
});

describe("loadConfig", () => {
  let dir: string;
  const savedEnv = process.env.OPENCLAW_CONFIG;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openclaw-config-"));
    delete process.env.OPENCLAW_CONFIG;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.OPENCLAW_CONFIG;
    else process.env.OPENCLAW_CONFIG = savedEnv;
  });

  function writeConfig(name: string, body: string): string {
    const file = join(dir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o600);
    return file;
  }

  it("parses an explicit TOML path through the schema", () => {
    const file = writeConfig(
      "openclaw.toml",
      [
        "[provider]",
        'type = "hermes"',
        'model = "hermes3:8b"',
        "",
        "[mcp.local]",
        'scopes = ["read", "write"]',
        "",
        "[agent]",
        "max_steps = 3",
      ].join("\n"),
    );

    const cfg = loadConfig(file);
    expect(cfg.provider).toMatchObject({
      type: "hermes",
      model: "hermes3:8b",
      transport: "ollama",
    });
    expect(cfg.mcp.local?.scopes).toEqual(["read", "write"]);
    expect(cfg.mcp.local?.command).toBe("node");
    expect(cfg.agent.max_steps).toBe(3);
    // Untouched sections still get their defaults.
    expect(cfg.agent.scratchpad_kb).toBe(64);
  });

  it("gives a config with no [agent] section usable audit settings", () => {
    // The README-style minimal config. `openclaw ask` used to throw
    // `TypeError: Cannot read properties of undefined (reading 'startsWith')`
    // in auditSink because audit_file came back undefined here.
    const file = writeConfig(
      "minimal.toml",
      '[provider]\ntype = "mock"\n\n[mcp.local]\n',
    );

    const cfg = loadConfig(file);
    expect(cfg.agent.audit_file).toBe("~/.openclaw/audit.log");
    expect(cfg.agent.max_steps).toBe(8);
    expect(cfg.agent.scratchpad_kb).toBe(64);
    expect(cfg.security.allow_filesystem_paths).toEqual([]);
    // The exact expression auditSink runs on it.
    expect(() => cfg.agent.audit_file.startsWith("~")).not.toThrow();
  });

  it("reads OPENCLAW_CONFIG when no explicit path is given", () => {
    const file = writeConfig(
      "env.toml",
      '[provider]\ntype = "openai"\nmodel = "gpt-4o"\n',
    );
    process.env.OPENCLAW_CONFIG = file;
    expect(loadConfig().provider).toMatchObject({
      type: "openai",
      model: "gpt-4o",
    });
  });

  it("prefers the explicit path over OPENCLAW_CONFIG", () => {
    process.env.OPENCLAW_CONFIG = writeConfig(
      "env.toml",
      '[provider]\ntype = "openai"\n',
    );
    const explicit = writeConfig(
      "explicit.toml",
      '[provider]\ntype = "mock"\n',
    );
    expect(loadConfig(explicit).provider.type).toBe("mock");
  });

  it("reports every candidate path when nothing exists", () => {
    const missing = join(dir, "nope.toml");
    expect(() => loadConfig(missing)).toThrow(/No config file found\. Tried:/);
    expect(() => loadConfig(missing)).toThrow(/nope\.toml/);
    expect(() => loadConfig(missing)).toThrow(/doctor --write-config/);
  });

  it("propagates a schema violation instead of silently defaulting", () => {
    const file = writeConfig(
      "bad.toml",
      '[provider]\ntype = "definitely-not-a-provider"\n',
    );
    expect(() => loadConfig(file)).toThrow();
  });

  it("propagates a TOML syntax error", () => {
    const file = writeConfig("broken.toml", "[provider\ntype = ");
    expect(() => loadConfig(file)).toThrow();
  });

  it.skipIf(platform() === "win32")(
    "refuses a group- or world-readable config file",
    () => {
      const file = join(dir, "loose.toml");
      writeFileSync(file, '[provider]\ntype = "mock"\n');
      chmodSync(file, 0o644);
      expect(() => loadConfig(file)).toThrow(
        /world- or group-readable.*chmod 600/s,
      );
    },
  );

  it.skipIf(platform() === "win32")("accepts a 0600 config file", () => {
    const file = writeConfig("tight.toml", '[provider]\ntype = "mock"\n');
    expect(loadConfig(file).provider.type).toBe("mock");
  });
});
