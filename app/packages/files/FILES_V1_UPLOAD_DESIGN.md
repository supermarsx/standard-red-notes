# FILES_V1 socket uploads: the `declaredSize` problem

**Status:** downloads ship over the socket lane. Uploads do **not**, and the transport
for them exists but has no consumer. This document explains why, so the next person
does not rediscover it.

**If you are here to wire uploads up: do not compute `declaredSize` as
`decryptedSize / 5_000_000`.** That is the trap. Read §1 and §2 first.

## 1. The constraint

`FILES_UPLOAD_OPEN` requires `declaredSize` — the total **encrypted** size — before a
single byte is sent. The current client upload pipeline cannot know it at that moment.

```
declaredSize = decryptedSize + ABYTES × chunkCount
```

`ABYTES` is the per-chunk xchacha20 secretstream overhead. It is **17**, measured
rather than assumed (1000 plaintext bytes → 1017 ciphertext;
`crypto_secretstream_xchacha20poly1305_ABYTES === 17`).

`chunkCount` is the problem. Three facts, all verified:

1. **`ByteChunker` emits chunks of *at least* `minimumChunkSize`, not exactly it.**
   `src/Domain/Chunker/ByteChunker.ts:33` computes
   `const maxIndex = Math.max(this.minimumChunkSize, this.bytes.length)`.
   If the reader hands it a buffer larger than the minimum, the whole buffer becomes
   one chunk. The name is literal. **This is the non-obvious one** — the code reads as
   fixed-size chunking until you look at that line.
2. **So the chunk count depends on runtime read sizes**, not on
   `decryptedSize / minimumChunkSize()`. Two runs over the same file can legitimately
   produce different chunk counts, and therefore different encrypted totals.
3. **`EncryptAndUploadFileOperation` only learns the total at the end.**
   `encryptedChunkSizes` accumulates one `pushBytes` at a time; there is no point
   before the final push where the sum exists.

## 2. Why guessing fails, and where

`declaredSize` is validated by the gateway three times: at open, on **every** chunk
header, and again at finish. The finish check is
`state.nextOffset !== state.descriptor.declaredSize → FILE_INCOMPLETE`.

So an arithmetic guess that is off by a single chunk does not fail fast. It fails at
`FILES_UPLOAD_FINISH` — **after the entire file has crossed the wire.** On a large file
over a slow link that is minutes of upload discarded, with an error that names neither
chunking nor size.

That is why this cannot be "shipped and fixed later". The failure is expensive,
late, and its message does not point at its cause.

## 3. Recommended design: the socket lane owns its chunk plan

Before opening the transfer, decide **exactly N chunks of exactly C decrypted bytes**
and feed the encryptor on that schedule, buffering at most one chunk. Then

```
declaredSize = decryptedSize + 17 × ceil(decryptedSize / C)
```

is true **by construction** rather than by assumption, and is independent of how the
underlying reader delivers bytes. HTTP upload behaviour is untouched.

## 4. Why it does not fit the decorator shape downloads use

Downloads plug in as `SocketPreferredFilesApi`, a decorator over `FilesApiInterface`
that overrides only `downloadFile`. Uploads cannot work that way.

`FilesApiInterface.uploadFileBytes` receives chunks that are **already encrypted**, at
sizes chosen upstream by whoever called `pushBytesForUpload`. By the time the API
boundary sees them, the chunk plan has already happened and `declaredSize` is already
undecidable. A socket upload therefore has to sit **where encryption chunking is
decided**, not at the API seam.

That is a structural change to the upload pipeline rather than plumbing, and it is why
this was stopped for a decision rather than pushed through.

## 5. Alternatives considered and rejected

- **Change `ByteChunker` to emit exact-size chunks.** Makes the arithmetic valid, but
  it is shared with the HTTP path, so it changes `encryptedChunkSizes` for existing
  uploads. Wider blast radius for a worse reason.
- **Buffer the whole encrypted stream, then measure it.** Defeats the streaming the
  5 GiB transfer cap exists for.
- **Let the server accept an unknown size.** Not available: `declaredSize` is a
  required, validated field of the protocol at all three checkpoints.

## 6. What already exists and is reusable

None of this needs revisiting; it is all landed, tested, and independent of §1.

| Piece | Where | Note |
| --- | --- | --- |
| Binary frame encoder/decoder | `Services/SyncTransport/syncTransportProtocol.ts` | Byte-identical to the gateway's, proven by round-trip and direct wire-prefix assertion |
| Streaming SHA-256 | `PureCryptoInterface.sha256Stream*`, `UseCase/EncryptedStreamDigest.ts` | The whole-file digest FINISH requires. A property of the **file**, not of a transfer attempt — it survives any number of resume cycles unchanged |
| Resume state machine | `UseCase/SocketUploadTransfer.ts` | Pure, 20 tests. **Takes `declaredSize` as a constructor argument**, so it does not care where the value comes from and is *not* blocked by this problem |
| Worker upload transport | `Services/SyncTransport/SyncTransportWorkerRuntime.ts` | Open/chunk/ack/finish/cancel frames, capability-gated. Has no consumer yet |

Two behaviours in there that are easy to break and worth knowing before you touch them:

- **`FILES_CHUNK_ACK` is addressed by `transferId`, not by the open frame's
  `commandId`.** Route on only the latter and every acknowledgement is silently
  dropped — the upload opens, sends the whole file, and hangs with no error.
- **`finishSent` is marked *before* the write, not after.** A client cannot know
  whether bytes it wrote arrived, so "I attempted FINISH" is the only transition point
  that never under-estimates the risk that the upload already applied. Everything after
  it is unsafe to replay over HTTP; everything before it is safe, because the server
  publishes only at `closeUploadSession`.

## 7. Known residual

Abandoned pre-FINISH upload sessions consume server-side storage until the files
service reaps them. This is a consequence of the fallback rule in §6 and is correct
behaviour on the client's side — inventing client-driven cleanup would be the wrong
place to solve it. It belongs to the files service's housekeeping.
