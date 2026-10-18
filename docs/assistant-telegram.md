---
layout: default
title: Assistant Telegram bridge
---

# Assistant Telegram bridge

The bridge connects a private Telegram bot conversation to an explicitly paired Standard Red Notes account. It collects messages into an inbox that the signed-in Assistant can read and answer using its Telegram tools. It does not run an autonomous model on the server, decrypt notes, or answer while every app client is closed. Group conversations, channel archives and arbitrary Telegram searches are not supported.

## Server setup

Create a dedicated bot through Telegram's BotFather. Set these variables on the API gateway (the bundled deployment runs it inside the server container), then restart the server:

```dotenv
TELEGRAM_ASSISTANT_BOT_TOKEN=123456:replace-with-your-bot-token
TELEGRAM_ASSISTANT_WEBHOOK_SECRET=replace-with-a-random-secret-at-least-32-characters
# Optional; keep this location on persistent storage.
TELEGRAM_ASSISTANT_STORE_PATH=/opt/server/packages/api-gateway/data/telegram-assistant.json
```

The webhook secret must contain 32–256 letters, digits, underscores or hyphens. The bot token stays on the server. Keep the bridge's state file on persistent storage: it contains pairing bindings, queued messages and delivery receipts. Losing that file loses pairings and replay protection. The server's Assistant Internet access setting must also be enabled; disabling it stops pairing, reading and sending. Revocation and acknowledgement remain available.

Register the webhook once against the public HTTPS application origin. Run this Bash example in an operator shell with the same two variables already supplied securely in its environment. Replace the public URL:

```bash
export SRN_PUBLIC_URL='https://notes.example.com'
curl --fail-with-body --silent --show-error \
  --request POST \
  "https://api.telegram.org/bot${TELEGRAM_ASSISTANT_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${SRN_PUBLIC_URL%/}/v1/assistant/telegram/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_ASSISTANT_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
```

This registers delivery; it does not send a chat message. Do not enable shell tracing or paste command output containing credentials into diagnostics. A bot supports one webhook destination, so use a dedicated bot if another service already consumes its updates. The reverse proxy must forward the webhook POST and its `X-Telegram-Bot-Api-Secret-Token` header.

Check the registered webhook using Telegram's read-only API:

```bash
curl --fail-with-body --silent --show-error \
  "https://api.telegram.org/bot${TELEGRAM_ASSISTANT_BOT_TOKEN}/getWebhookInfo"
```

See Telegram's official [webhook documentation](https://core.telegram.org/bots/api#setwebhook) and [update delivery contract](https://core.telegram.org/bots/api#getting-updates). Telegram retains undelivered updates for at most 24 hours.

## Pair and use

In Assistant settings, create a pairing code. Send `/start CODE` privately to the configured bot within ten minutes. The code is single-use and stored only as a hash. The account is bound to that private Telegram sender and chat; another account cannot take over the same sender. Re-pairing the same sender preserves queued messages. To change sender, revoke the current pairing first.

Send a message to the bot, then ask the Assistant to read the Telegram inbox and reply. Telegram replies are outbound messages and follow the Assistant's tool-permission flow. Replies are limited to 4,096 characters each. The bridge does not automatically expose your selected notes to Telegram; the reply text is what gets sent.

The authenticated API is also available to the app:

| Method | Route                           | Purpose                                          |
| ------ | ------------------------------- | ------------------------------------------------ |
| GET    | `/v1/assistant/telegram`        | Configuration, pairing status and account inbox  |
| POST   | `/v1/assistant/telegram/pair`   | Generate a short-lived pairing code              |
| POST   | `/v1/assistant/telegram/revoke` | Delete pairing and queued data                   |
| POST   | `/v1/assistant/telegram/reply`  | Send `{ "updateId": 123, "text": "Reply" }`      |
| POST   | `/v1/assistant/telegram/ack`    | Dismiss `{ "updateIds": [123] }` without sending |

These account routes require the normal authenticated application session. The public webhook uses the configured webhook secret instead. Callers cannot choose another account or an arbitrary reply destination.

## Delivery and privacy

Telegram messages and their pending inbox copies are readable by Telegram and by this server. They are not the app's end-to-end encrypted note/chat records. Pair only if this is acceptable for the messages you send. Queued text is removed after a confirmed successful reply, explicit acknowledgement, or revocation.

Each account can queue 100 messages. Capacity exhaustion returns an explicit failure so Telegram can retry instead of silently dropping an older message. The store retains up to 4,096 replay receipts per account; receipts normally expire after 48 hours, while receipts for still-pending messages remain. Successful replies free inbox capacity and retain their sent receipt to prevent duplicate dispatch.

If sending times out, the connection fails, or the process dies while sending, the bridge cannot prove whether Telegram delivered the message. It records a delivery state of `uncertain` or `sending` and refuses automatic resends. Check the Telegram conversation first. Acknowledge the original inbox entry after checking; if another reply is needed, send a fresh message to the bot and reply to that new inbox entry. This avoids sending duplicate replies after ambiguous network failures.

Revoking pairing prevents future queued work. An outbound request already dispatched to Telegram may still complete. Keep this distinction in mind when revoking during a reply.
