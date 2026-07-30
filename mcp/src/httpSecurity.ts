import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import net from "node:net";

export class HttpInputError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rpcCode: number,
  ) {
    super(message);
  }
}

export function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  limits: { min: number; max: number; name: string },
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < limits.min ||
    parsed > limits.max
  ) {
    throw new Error(
      `${limits.name} must be an integer between ${limits.min} and ${limits.max}`,
    );
  }
  return parsed;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (net.isIPv4(normalized)) {
    return normalized.startsWith("127.");
  }
  return false;
}

export function assertSafeHttpBinding(input: {
  host: string;
  allowRemote: boolean;
  token: string | undefined;
}): void {
  if (isLoopbackHost(input.host)) {
    return;
  }
  if (!input.allowRemote) {
    throw new Error(
      "non-loopback MCP_HTTP_HOST requires MCP_HTTP_ALLOW_REMOTE=1",
    );
  }
  if (!input.token || Buffer.byteLength(input.token, "utf8") < 32) {
    throw new Error(
      "remote HTTP binding requires an MCP_HTTP_TOKEN of at least 32 bytes",
    );
  }
}

export function assertDistinctHttpCredentials(input: {
  httpToken: string;
  accountToken: string | undefined;
  password: string | undefined;
}): void {
  for (const [name, credential] of [
    ["STANDARD_RED_NOTES_MCP_TOKEN", input.accountToken],
    ["STANDARD_RED_NOTES_PASSWORD", input.password],
  ] as const) {
    if (credential && credential === input.httpToken) {
      throw new Error(`MCP_HTTP_TOKEN must be distinct from ${name}`);
    }
  }
}

export function isBearerAuthorized(
  authorizationHeader: string | string[] | undefined,
  token: string | undefined,
): boolean {
  if (!token || typeof authorizationHeader !== "string") {
    return false;
  }
  const prefix = "Bearer ";
  if (!authorizationHeader.startsWith(prefix)) {
    return false;
  }
  const presented = Buffer.from(
    authorizationHeader.slice(prefix.length),
    "utf8",
  );
  const expected = Buffer.from(token, "utf8");
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

export function isInitializeRequest(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).jsonrpc === "2.0" &&
    (body as Record<string, unknown>).method === "initialize"
  );
}

export async function readBoundedJsonBody(
  req: IncomingMessage,
  options: { maxBytes: number; timeoutMs: number },
): Promise<unknown> {
  const encoding = req.headers["content-encoding"];
  if (typeof encoding === "string" && encoding.toLowerCase() !== "identity") {
    throw new HttpInputError(
      "compressed request bodies are not accepted",
      415,
      -32600,
    );
  }
  const contentType = req.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  ) {
    throw new HttpInputError(
      "Content-Type must be application/json",
      415,
      -32600,
    );
  }
  const declaredLength = req.headers["content-length"];
  if (typeof declaredLength === "string") {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new HttpInputError("invalid Content-Length", 400, -32600);
    }
    if (parsed > options.maxBytes) {
      throw new HttpInputError("request body too large", 413, -32600);
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        req.destroy();
        reject(new HttpInputError("request body timed out", 408, -32000));
      }, options.timeoutMs);
      timer.unref?.();
    });
    const read = (async () => {
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > options.maxBytes) {
          throw new HttpInputError("request body too large", 413, -32600);
        }
        chunks.push(bytes);
      }
      if (size === 0) {
        throw new HttpInputError("request body is empty", 400, -32700);
      }
      try {
        return JSON.parse(
          Buffer.concat(chunks, size).toString("utf8"),
        ) as unknown;
      } catch {
        throw new HttpInputError("request body is not valid JSON", 400, -32700);
      }
    })();
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function withHttpRequestTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HttpInputError(
                "MCP request timed out; operation outcome is unknown, verify state before retrying",
                504,
                -32000,
              ),
            ),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function cleanupFailedInitialization<
  T extends { sessionId?: string; close(): Promise<void> },
  S,
>(sessions: Map<string, S>, transport: T): Promise<void> {
  if (transport.sessionId) {
    sessions.delete(transport.sessionId);
  }
  await transport.close().catch(() => {});
}

export async function evictIdleSessions<T extends { lastSeenAt: number }>(
  sessions: Map<string, T>,
  now: number,
  idleMs: number,
  close: (session: T) => Promise<void>,
): Promise<number> {
  let evicted = 0;
  for (const [id, session] of sessions) {
    if (now - session.lastSeenAt < idleMs) {
      continue;
    }
    // Delete before awaiting close so no request can reuse an expiring
    // session while its SSE stream is being torn down.
    sessions.delete(id);
    evicted += 1;
    await close(session).catch(() => {});
  }
  return evicted;
}
