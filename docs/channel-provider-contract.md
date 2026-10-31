# Independent IM provider contract

Each provider repository owns `src/provider.js`, platform documentation and its
fixture tests. Core owns MCP, single-owner authorization, encrypted SQLite state,
callback subscriptions, durable inbox/outbox and lifecycle. The distribution owns
installation and process composition. Never copy shared runtime code into a channel.

```js
export function createProvider({
  credentials, state, onMessage, signal,
  fetch = globalThis.fetch, WebSocket = globalThis.WebSocket
}) {
  return {
    async start() {},
    async stop() {},
    status() { return { connected: false }; },
    async sendReply({ message, text, idempotencyKey }) {
      return { providerMessageId: 'optional-provider-id' };
    }
  };
}
```

- `credentials` is the parsed protected provider JSON. Common `ownerId` and
  `conversationId` are required strings. Channel docs describe additional fields.
  Credentials are provisioned by the operator; no implicit enrollment or new keys.
- `state.get(key)` / `state.set(key,value)` / `state.delete(key)` are synchronous
  encrypted persistent JSON storage, namespaced to the selected provider. Persist
  polling cursors and resume state only after `await onMessage` succeeds. Core
  returns false for disallowed/duplicate messages; these have been handled and may
  be acknowledged. Exceptions mean ingestion did not succeed.
- `start()` starts the provider and returns after initialization; it must not wait
  for the entire polling loop. `stop()` cancels requests/timers, closes sockets and
  awaits owned work. `signal` is aborted during shutdown. Do not leave promises
  rejected without handlers. Recover only connection/polling operations; never
  automatically retry an uncertain send.
- `onMessage(message)` receives `{id, senderId, conversationId, text, timestamp?,
  replyDeadline?, replyContext?, attachments?}`. IDs are bounded nonempty strings;
  timestamp/deadline are epoch milliseconds. Text is at most 20,000 characters.
  `replyContext` is private JSON sufficient to reply to the original conversation.
  `attachments` is at most ten metadata records `{kind,name?,mimeType?}`. Private
  file IDs, signed download references and encryption keys belong only in the
  encrypted `replyContext`, indexed in the same order as attachment metadata.
  Ignore bot/self/system events. Core independently checks exact owner and private
  conversation binding. No arbitrary-recipient send API is exposed to dot.
- The `message` passed to `sendReply` is the stored normalized message including
  its private replyContext. Do not accept a recipient supplied by a tool caller.
  `idempotencyKey` is stable and should be mapped to official idempotency support
  when available. A timeout/error after sending is uncertain; core will not retry.
- HTTP endpoints must be fixed official HTTPS origins. Disable redirects and
  bound response bodies/timeouts. Never forward credentials to a host taken from
  a message. Server-issued reply URLs require exact official hostname/path policy.
- Do not print raw SDK errors or protocol frames. `status()` exposes only bounded
  booleans. Test via injected fetch/WebSocket or explicit SDK test injection.
- Platforms needing inbound webhooks may expose `handleWebhook({headers,body})`:
  body is a bounded Buffer, headers lower-case strings. Verify signature before
  parsing or accepting events. Return `{status:200,body:''}`. Core serves it on
  the provider's separate loopback webhook listener, never on the MCP listener;
  operator configures the external HTTPS reverse proxy. Add `webhookPort` to
  channel metadata when needed. No automatic firewall/TLS/proxy changes.

Public component wrappers are maintained centrally: `./adapter`, `./config`,
`./runtime/live` (explicit `--confirm-live`) and `./runtime/readiness` (no provider
import, credentials, database or network). New repositories use the same pinned
core release. Workers may add provider SDK dependencies but must coordinate the
core dependency/provenance with the parent before final packaging.

## Optional media methods

Set channel metadata `media: {read: ['image','audio','file'], reply: [...]}` only
for kinds actually supported by the provider. Unsupported kinds remain metadata.
Use `maxMediaReplyText` for the platform caption limit, including zero when a
single media reply cannot carry text. Do not send an extra text message to fake
a caption: one source message has one durable final reply.

`readAttachment({message, attachmentIndex})` returns
`{data: Buffer, mimeType: string, name?: string}`. Download only the reference in
the authorized stored message; validate the exact official host and path, bound
the response to `MAX_MEDIA_BYTES` (currently 5 MiB), and never follow redirects. Core checks authorization
before and after the read and after optional local transcription. No file IDs,
provider URLs or tokens appear in the public tool result. Raw source audio and
reference transcription are distinct; do not label a transcript as hearing.

`validateMediaReply({media, text})` is an optional synchronous validation step
before queueing. Reject formats, sizes and captions the provider cannot send.
`sendMediaReply({message, media, text, idempotencyKey, authorize})` accepts
`media: {type, data: Buffer, mimeType, name}`. Derive the target solely from the
stored original conversation. Core encrypts queued bytes, limits retained media,
and preserves uncertain sends across restarts without retry. No caller paths,
URLs or recipients are accepted. Media URLs requiring public hosting are not
provided automatically.

Call the synchronous `authorize()` guard before each outbound mutation, including
upload reservation, upload and final message send. An unsubscribe or expiry during
upload must stop the later send. Do not catch its rejection and continue sending.

Providers that receive SILK can pin `silk-wasm` and use the shared
`createSilkDecoder(import.meta.resolve('silk-wasm'))` from
`@dot-bridge/core/audio/silk.js`. This runs bounded decoding in a worker and
returns WAV without temporary media files. The module URL is trusted code,
never tool input or environment configuration.

`createSilkEncoder` uses the same worker boundary for native voice output. It accepts
PCM16 mono WAV at supported sample rates, at most 120 seconds and 8 MiB. Providers
still apply their own stricter media limits before queueing.

## Tunnel budgets and authenticated status

Import `MAX_MEDIA_BYTES`, `MAX_MEDIA_BASE64` and `MEDIA_RPC_LIMIT` from
`@dot-bridge/core/channels/media.js`; do not maintain per-channel copies of the
shared Tunnel allowance. Smaller platform limits still apply. The current 5 MiB
original-file limit leaves room for Base64, duplicated metadata and the complete
official 10 MiB serialized Tunnel envelope. The media RPC budget includes 512 KiB
for JSON/UTF-8 metadata. A separate 256 KiB envelope reserve is retained even in
the conservative case where the entire MCP body is Base64-encoded again. The
official client's `jsonrpc` / `resp_json` fields currently carry raw JSON.

The existing `check_<channel>_setup` and live readiness results retain their
original required fields. These additional fields are optional, so a management
client can work with older backends without inventing missing observations:

- `subscription_status`: `state` is `none`, `active`, `expired`, `disabled` or
  `unknown`; `expires_at` and `remaining_seconds` come only from stored data,
  otherwise they are null. `renewal_owner` is `host`. `none` describes the current
  absence of a stored subscription, not whether a past request ever arrived.
- `connection_status`: fixed `stage`, `reason`, `next_step`, exact
  `callback_hosts_count`, and `diagnostic_history` (`available` / `unavailable`).
  `callback_hosts_configured` reports whether the validated correct setting has
  entries. `legacy_callback_alias_present` reports only whether the unsupported
  `MCP_CALLBACK_ALLOWED_HOSTS` name has a value. It never enables that alias.
- `reply_work`: complete persisted `pending`, `processing` and `uncertain`
  reply counts. The existing ten-item pending-reference list is not an outbox
  total and cannot establish that an upgrade or rollback is safe.
- `media_limits`: `read_bytes`, `reply_bytes`, `mcp_body_bytes` and
  `tunnel_envelope_bytes`; these describe byte budgets, not provider connectivity.
- `media_readiness`: optional booleans `reply_publisher_configured` and
  `reply_publisher_required`, projected only from corresponding boolean
  `status().mediaPublisherConfigured` / `mediaPublisherRequired`. No URL or key is
  exposed; unknown observations are omitted.
- `reply_capabilities`: emitted only when channel metadata explicitly declares
  `nativeMaxReplyText` and `longReplyMode`. It contains `max_text_chars`,
  `native_text_chars` and `long_reply_mode` (`file`, `chunks` or `none`). Providers
  own the safe single-operation long-reply behavior; core does not truncate or
  blindly retry text as a second media reply after an uncertain send.

`subscription_diagnostics` retains only existing records, at most five, with
time, stage, RPC code, fixed reason and hostname. No records means the failure
cannot be reconstructed. Status reads do not approve hosts, contact callbacks,
create/renew subscriptions or mutate private configuration. Subscription expiry
does not grant the bridge authority to renew a host-owned subscription.

## Subscription diagnosis

The setup tool returns the last five `subscription_diagnostics` records. They
contain only UTC time, a fixed phase/reason, RPC code and validated hostname.
They are stored in encrypted metadata with the existing storage key. Empty
history means no usable stored record; it does not establish whether a request
arrived, and cannot reconstruct old failures. Never retain callback paths, signing keys, identity or provider
exception text. Generic channels use `CALLBACK_HOSTS`; legacy QQ/Lark still use
`MCP_CALLBACK_ALLOWED_HOSTS`. An incorrect-only alias is rejected explicitly.
