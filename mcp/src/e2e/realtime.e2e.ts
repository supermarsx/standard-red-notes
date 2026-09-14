import {
  check,
  cleanup,
  finish,
  freshAccount,
  GATEWAY_WS,
  isPushFrame,
  SERVER,
  serverUp,
} from "./helpers.js";
import { SnjsBackedClient } from "../snjs/SnjsBackedClient.js";

// FULL realtime chain: a note saved through the bridge → server emits
// WEB_SOCKET_MESSAGE_REQUESTED → SNS/SQS → gateway → push delivered to a
// connected WebSocket. Requires the stack up.
//
// The connection token is minted the way a real client mints it — through the
// api-gateway with the session's bearer token, at the public front door. The
// gateway's own `x-internal-secret` endpoint is NOT usable from here any more
// and should not be: nginx blanks that header on `/sockets`, and the gateway
// refuses an internal mint whenever `x-forwarded-for` is present or the peer is
// not loopback, so the internet-facing credential is inert by design.
async function main() {
  if (!(await serverUp())) {
    console.log("SKIP: server not reachable on", SERVER);
    process.exit(0);
  }

  const { app, dataDir } = await freshAccount();
  const session = app.app.sessions.getSession?.();
  const accessToken: string | undefined =
    session?.accessToken?.value ?? session?.accessToken;
  check(
    "bridge has a live session access token",
    typeof accessToken === "string" && accessToken.length > 0,
  );

  const mint = await fetch(`${SERVER}/v1/sockets/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: "{}",
  });
  const body = (await mint.json().catch(() => ({}))) as {
    token?: string;
    data?: { token?: string };
  };
  const token = body.token ?? body.data?.token;
  check(
    "connection token minted at the front door",
    mint.status === 200 && typeof token === "string" && token.length > 0,
  );
  if (typeof token !== "string") {
    await cleanup(app, dataDir);
    finish();
    return;
  }

  const pushed = await new Promise<string | null>((resolve) => {
    // GATEWAY_WS already ends in the pinned `/sockets` pathname (C13).
    const ws = new WebSocket(`${GATEWAY_WS}?authToken=${token}`);
    ws.onopen = async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const client = new SnjsBackedClient(app, {
        allowWrites: true,
        baseUrl: SERVER,
      });
      await client.createNote({ title: "Realtime", body: "push me", tags: [] });
    };
    ws.onmessage = (ev: MessageEvent) => resolve(String(ev.data));
    ws.onerror = () => resolve(null);
    setTimeout(() => resolve(null), 40000);
  });

  check(
    "realtime push delivered (save -> emit -> SNS/SQS -> gateway -> socket)",
    isPushFrame(pushed),
  );

  await cleanup(app, dataDir);
  finish();
}

main().catch((e) => {
  console.error("E2E ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
