import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, test } from "vitest";
import {
  assertDistinctHttpCredentials,
  assertSafeHttpBinding,
  cleanupFailedInitialization,
  evictIdleSessions,
  HttpInputError,
  isBearerAuthorized,
  isInitializeRequest,
  parseBoundedInteger,
  readBoundedJsonBody,
  withHttpRequestTimeout,
} from "../src/httpSecurity.js";

function request(
  body: string,
  headers: Record<string, string> = {
    "content-type": "application/json",
  },
): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as IncomingMessage;
  Object.defineProperty(stream, "headers", { value: headers });
  return stream;
}

describe("HTTP MCP boundary", () => {
  test("binds loopback by default and requires explicit strong auth remotely", () => {
    expect(() =>
      assertSafeHttpBinding({
        host: "127.0.0.1",
        allowRemote: false,
        token: "short",
      }),
    ).not.toThrow();
    expect(() =>
      assertSafeHttpBinding({
        host: "0.0.0.0",
        allowRemote: false,
        token: "x".repeat(64),
      }),
    ).toThrow("MCP_HTTP_ALLOW_REMOTE=1");
    expect(() =>
      assertSafeHttpBinding({
        host: "0.0.0.0",
        allowRemote: true,
        token: "short",
      }),
    ).toThrow("at least 32 bytes");
  });

  test("checks exact bearer tokens", () => {
    expect(isBearerAuthorized("Bearer correct", "correct")).toBe(true);
    expect(isBearerAuthorized("Bearer correcT", "correct")).toBe(false);
    expect(isBearerAuthorized("Basic correct", "correct")).toBe(false);
  });

  test("requires separate bridge and account credentials", () => {
    expect(() =>
      assertDistinctHttpCredentials({
        httpToken: "bridge-secret",
        accountToken: "bridge-secret",
        password: undefined,
      }),
    ).toThrow(/STANDARD_RED_NOTES_MCP_TOKEN/);
    expect(() =>
      assertDistinctHttpCredentials({
        httpToken: "bridge-secret",
        accountToken: undefined,
        password: "bridge-secret",
      }),
    ).toThrow(/STANDARD_RED_NOTES_PASSWORD/);
    expect(() =>
      assertDistinctHttpCredentials({
        httpToken: "bridge-secret",
        accountToken: "scoped-account-secret",
        password: "password-secret",
      }),
    ).not.toThrow();
  });

  test("accepts only a JSON-RPC initialize request for a new session", () => {
    expect(
      isInitializeRequest({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
      }),
    ).toBe(true);
    expect(isInitializeRequest([{ method: "initialize" }])).toBe(false);
    expect(isInitializeRequest({ method: "tools/list" })).toBe(false);
  });

  test("reads and parses a bounded JSON body", async () => {
    await expect(
      readBoundedJsonBody(request('{"jsonrpc":"2.0"}'), {
        maxBytes: 100,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ jsonrpc: "2.0" });
  });

  test("rejects oversized and malformed bodies with protocol-safe status", async () => {
    const oversized = readBoundedJsonBody(request('{"large":"payload"}'), {
      maxBytes: 4,
      timeoutMs: 1_000,
    });
    await expect(oversized).rejects.toMatchObject<HttpInputError>({
      status: 413,
    });
    await expect(
      readBoundedJsonBody(request("{"), {
        maxBytes: 100,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject<HttpInputError>({ status: 400, rpcCode: -32700 });
  });

  test("validates bounded integer configuration", () => {
    expect(
      parseBoundedInteger(undefined, 5, { min: 1, max: 10, name: "TEST" }),
    ).toBe(5);
    expect(() =>
      parseBoundedInteger("11", 5, { min: 1, max: 10, name: "TEST" }),
    ).toThrow("TEST must be an integer");
  });

  test("bounds non-streaming request execution", async () => {
    await expect(
      withHttpRequestTimeout(new Promise(() => undefined), 5),
    ).rejects.toMatchObject<HttpInputError>({
      status: 504,
      message:
        "MCP request timed out; operation outcome is unknown, verify state before retrying",
    });
  });

  test("cleans a session initialized before its response later fails", async () => {
    const transport = {
      sessionId: "half-open",
      close: async () => {
        transport.closed += 1;
      },
      closed: 0,
    };
    const sessions = new Map([["half-open", { transport }]]);
    await cleanupFailedInitialization(sessions, transport);
    expect(sessions.size).toBe(0);
    expect(transport.closed).toBe(1);
  });

  test("evicts and closes only naturally idle sessions", async () => {
    const closed: string[] = [];
    const sessions = new Map([
      ["expired", { id: "expired", lastSeenAt: 1_000 }],
      ["boundary", { id: "boundary", lastSeenAt: 2_000 }],
      ["active", { id: "active", lastSeenAt: 2_001 }],
    ]);
    await expect(
      evictIdleSessions(sessions, 3_000, 1_000, async (session) => {
        closed.push(session.id);
      }),
    ).resolves.toBe(2);
    expect(closed).toEqual(["expired", "boundary"]);
    expect([...sessions.keys()]).toEqual(["active"]);
  });
});
