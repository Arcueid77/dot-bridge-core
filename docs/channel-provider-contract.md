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
  `attachments` is at most ten metadata records `{kind,name?,mimeType?}`; v1 sends
  text and reports attachment metadata only. Do not claim binary media processing.
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
