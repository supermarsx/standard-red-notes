import { describe, expect, it } from "vitest";
import { redactForAudit } from "../src/util/redact.js";

/**
 * Regression tests for the audit-log credential leak.
 *
 * `ask` and `chat` append every tool call to ~/.openclaw/audit.jsonl, so any
 * argument that carries a credential is persisted to disk. Before the fix,
 * redaction keyed only on body/content/text/password and on a value regex that
 * required the token prefix to be glued to the token, which meant `token`,
 * `apiKey`, `secret` and the canonical `Bearer <token>` header value were all
 * written in the clear.
 */

function json(value: unknown): string {
  return JSON.stringify(redactForAudit(value));
}

describe("credential-bearing keys are redacted", () => {
  it.each([
    ["token", { token: "hunter2abcdefgh" }, "hunter2abcdefgh"],
    ["apiKey", { apiKey: "abcd1234wxyz" }, "abcd1234wxyz"],
    ["api_key", { api_key: "abcd1234wxyz" }, "abcd1234wxyz"],
    ["api-key", { "api-key": "abcd1234wxyz" }, "abcd1234wxyz"],
    ["secret", { secret: "abcd1234wxyz" }, "abcd1234wxyz"],
    ["accessToken", { accessToken: "abcd1234wxyz" }, "abcd1234wxyz"],
    ["refresh_token", { refresh_token: "abcd1234wxyz" }, "abcd1234wxyz"],
    ["clientSecret", { clientSecret: "abcd1234wxyz" }, "abcd1234wxyz"],
    ["credentials", { credentials: "abcd1234wxyz" }, "abcd1234wxyz"],
    ["authorization", { authorization: "Bearer abcd1234wxyz" }, "abcd1234wxyz"],
    // Opaque value: no pattern matches it, so only the key rule can save it.
    [
      "authorization (opaque)",
      { authorization: "zzzz9999yyyy" },
      "zzzz9999yyyy",
    ],
    ["auth", { auth: "abcd1234wxyz" }, "abcd1234wxyz"],
    ["cookie", { cookie: "sess=abcd1234wxyz" }, "abcd1234wxyz"],
    ["session", { session: "abcd1234wxyz" }, "abcd1234wxyz"],
    ["password", { password: "hunter2" }, "hunter2"],
  ])(
    "never writes the value of %s to the audit log",
    (_name, input, secret) => {
      expect(json(input)).not.toContain(secret);
    },
  );

  it("redacts a credential nested inside objects and arrays", () => {
    const out = json({
      request: {
        headers: [{ authorization: "Bearer abcd1234wxyz" }],
        retries: [{ nested: { apiKey: "abcd1234wxyz" } }],
      },
    });

    expect(out).not.toContain("abcd1234wxyz");
  });

  it("redacts the value whatever its shape, not just token-looking strings", () => {
    // The leak was worst here: a credential that does not match the value
    // regex used to pass straight through because of its key alone.
    expect(json({ token: 12345678 })).not.toContain("12345678");
    expect(json({ apiKey: ["abcd1234wxyz"] })).not.toContain("abcd1234wxyz");
  });
});

describe("credential-shaped values are redacted wherever they appear", () => {
  it.each([
    ["canonical bearer header", "Authorization: Bearer abcd1234wxyzQQ"],
    ["basic auth header", "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l"],
    ["vendor key", "sk-abc12345xyz_more"],
    ["github token", "ghp_abcdefgh12345678"],
    ["slack token", "xoxb-1234567890-abcdefghijkl"],
    [
      "jwt",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
  ])("masks a %s found in a free-text value", (_name, value) => {
    const out = redactForAudit({ note: value }) as Record<string, string>;
    expect(out.note).toContain("<redacted-token>");
  });
});

describe("redaction does not swallow innocuous data", () => {
  it.each([
    ["tokenCount", { tokenCount: 42 }, "42"],
    ["tokenizer", { tokenizer: "bpe-v2" }, "bpe-v2"],
    ["keyboard", { keyboard: "qwerty" }, "qwerty"],
    ["monkey", { monkey: "curious george" }, "curious george"],
    ["contentType", { contentType: "text/plain" }, "text/plain"],
    ["title", { title: "shopping list" }, "shopping list"],
  ])("leaves %s intact", (_name, input, kept) => {
    expect(json(input)).toContain(kept);
  });

  it("leaves ordinary prose that merely mentions tokens alone", () => {
    const out = redactForAudit({
      note: "tokenization is a preprocessing technique",
    }) as Record<string, string>;

    expect(out.note).toBe("tokenization is a preprocessing technique");
  });
});

describe("existing redaction behaviour is preserved", () => {
  it("still summarises note bodies rather than storing them", () => {
    const out = redactForAudit({ title: "shopping", body: "milk" }) as Record<
      string,
      string
    >;

    expect(out.title).toBe("shopping");
    expect(out.body).toMatch(/^<note:/);
  });

  it("still recurses into arrays", () => {
    const out = redactForAudit([
      { body: "secret" },
      "sk-abc12345xyz",
    ]) as unknown[];

    expect((out[0] as Record<string, string>).body).toMatch(/^<note:/);
    expect(out[1]).toBe("<redacted-token>");
  });

  it("preserves null and undefined rather than masking them", () => {
    expect(redactForAudit(null)).toBeNull();
    expect(redactForAudit(undefined)).toBeUndefined();
  });
});
