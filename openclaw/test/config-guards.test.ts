import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The permission guard in loadConfig is a POSIX-only code path, so on a Windows
 * developer machine it is skipped and never measured. Faking `platform()` lets
 * the guard itself be tested on any host — the logic is what matters, not the
 * kernel underneath it.
 */

const h = vi.hoisted(() => ({
  platform: "linux" as string,
  mode: 0o600,
  /** Files the fake filesystem knows about, keyed by the path read. */
  files: new Map<string, string>(),
  readError: null as unknown,
  statted: [] as string[],
  read: [] as string[],
}));

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

vi.mock("node:os", () => ({
  platform: () => h.platform,
  homedir: () => "/home/tester",
  tmpdir: () => "/tmp",
}));

/**
 * `expand()` runs paths through `resolve()`, which on Windows prefixes a drive
 * letter and flips the separators, so the fake filesystem matches on the tail
 * of the path rather than on an exact string.
 */
function lookup(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/");
  for (const [key, body] of h.files) {
    if (normalized.endsWith(key)) return body;
  }
  return undefined;
}

vi.mock("node:fs", () => ({
  statSync: (path: string) => {
    h.statted.push(path);
    if (lookup(path) === undefined) throw enoent(path);
    return { mode: h.mode };
  },
  readFileSync: (path: string) => {
    h.read.push(path);
    if (h.readError) throw h.readError;
    const body = lookup(path);
    if (body === undefined) throw enoent(path);
    return body;
  },
}));

const { loadConfig } = await import("../src/config/load.js");

const savedEnv = process.env.OPENCLAW_CONFIG;

beforeEach(() => {
  h.platform = "linux";
  h.mode = 0o600;
  h.files = new Map();
  h.readError = null;
  h.statted = [];
  h.read = [];
  delete process.env.OPENCLAW_CONFIG;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.OPENCLAW_CONFIG;
  else process.env.OPENCLAW_CONFIG = savedEnv;
});

describe("config file permission guard", () => {
  it.each([
    ["group-readable", 0o640],
    ["world-readable", 0o604],
    ["world-writable", 0o622],
    ["wide open", 0o777],
  ])("refuses a %s config on a POSIX host", (_name, mode) => {
    h.mode = mode;
    h.files.set("/cfg.toml", '[provider]\ntype = "mock"\n');

    expect(() => loadConfig("/cfg.toml")).toThrow(
      /world- or group-readable.*chmod 600/s,
    );
  });

  it("reports the offending mode in octal so the fix is obvious", () => {
    h.mode = 0o644;
    h.files.set("/cfg.toml", '[provider]\ntype = "mock"\n');

    expect(() => loadConfig("/cfg.toml")).toThrow(/mode 644/);
  });

  it.each([
    ["owner-only read/write", 0o600],
    ["owner-only read", 0o400],
  ])("accepts a %s config", (_name, mode) => {
    h.mode = mode;
    h.files.set("/cfg.toml", '[provider]\ntype = "mock"\n');

    expect(loadConfig("/cfg.toml").provider.type).toBe("mock");
  });

  it("skips the permission check entirely on win32, where the bits are meaningless", () => {
    h.platform = "win32";
    h.mode = 0o777;
    h.files.set("/cfg.toml", '[provider]\ntype = "mock"\n');

    expect(loadConfig("/cfg.toml").provider.type).toBe("mock");
    // The guard returns before it ever stats the file.
    expect(h.statted).toEqual([]);
  });
});

describe("config path resolution", () => {
  it("expands a leading ~ against the home directory", () => {
    expect(() => loadConfig("~/.openclaw/config.toml")).toThrow(
      /No config file found/,
    );
    expect(h.statted).toHaveLength(1);
    expect(h.statted[0]).toMatch(/[\\/]home[\\/]tester[\\/]\.openclaw[\\/]/);
  });

  it("falls back to both default paths when nothing is configured", () => {
    expect(() => loadConfig()).toThrow(/No config file found\. Tried:/);
    expect(() => loadConfig()).toThrow(/openclaw\.toml/);
    expect(() => loadConfig()).toThrow(/config\.toml/);
  });

  it("tries the default paths in order and stops at the first that loads", () => {
    // The second default is ~/.openclaw/config.toml; the first does not exist.
    const home = h.statted;
    expect(() => loadConfig()).toThrow();
    expect(home.length).toBeGreaterThanOrEqual(2);
    expect(home[0]).toMatch(/openclaw\.toml$/);
    expect(home[1]).toMatch(/[\\/]\.openclaw[\\/]config\.toml$/);
  });

  it("propagates a non-ENOENT filesystem error instead of trying the next candidate", () => {
    h.files.set("/cfg.toml", '[provider]\ntype = "mock"\n');
    h.readError = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });

    expect(() => loadConfig("/cfg.toml")).toThrow("EACCES: permission denied");
  });
});
