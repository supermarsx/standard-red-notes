import { test, expect } from "vitest";

// The polyfill captures `globalThis.fetch` at module-load time, so the fake must
// be installed before it is imported — hence the dynamic import below rather
// than a static one.
const calls: { url: string; cookie: string | null }[] = [];
let nextSetCookies: string[] = [];

globalThis.fetch = (async (input: unknown, init?: { headers?: unknown }) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as { url: string }).url;
  const headers = new Headers((init?.headers ?? undefined) as HeadersInit);
  calls.push({ url, cookie: headers.get("cookie") });

  const responseHeaders = new Headers();
  for (const cookie of nextSetCookies) {
    responseHeaders.append("set-cookie", cookie);
  }
  nextSetCookies = [];
  return new Response(null, { headers: responseHeaders });
}) as typeof globalThis.fetch;

await import("../src/polyfill.ts");

test("browser globals snjs touches at load time are shimmed", () => {
  expect((globalThis as Record<string, unknown>).self).toBe(globalThis);
  expect((globalThis as Record<string, unknown>).window).toBe(globalThis);
  expect((globalThis as Record<string, unknown>).document).toBeDefined();
});

test("the cookie jar replays Set-Cookie back to the same origin", async () => {
  nextSetCookies = ["session=abc; Path=/; HttpOnly"];
  await fetch("https://a.example/sign-in");
  expect(calls.at(-1)?.cookie).toBeNull();

  await fetch("https://a.example/items");
  expect(calls.at(-1)?.cookie).toBe("session=abc");
});

test("the cookie jar is scoped per origin", async () => {
  await fetch("https://b.example/items");
  expect(calls.at(-1)?.cookie).toBeNull();
});

test("a Max-Age=0 Set-Cookie deletes the stored cookie", async () => {
  nextSetCookies = ["session=; Path=/; Max-Age=0"];
  await fetch("https://a.example/sign-out");
  expect(calls.at(-1)?.cookie).toBe("session=abc");

  await fetch("https://a.example/items");
  expect(calls.at(-1)?.cookie).toBeNull();
});
