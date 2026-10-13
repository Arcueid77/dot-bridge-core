# Shared callback transport

Dependency-free ESM transport used by the QQ bridge and its sibling Lark bridge.
The ordinary entry preserves HTTPS hostname checks, all-answer public-address
validation, direct address pinning, bounds, cancellation and no redirect/retry.
A separate explicit owner-message experiment uses the existing selected proxy
without claiming to validate its final IP. Neither mode reads credential files,
starts a service, logs payloads, or creates persistent access.

## Distribution and imports

Copy/install package.json and its files allowlist together. dot-bridge-core owns this canonical source. IM repositories install the reviewed
@dot-bridge/core release and import @dot-bridge/core/transport; they do not require
a sibling checkout or maintain independent source copies.

- @dot-bridge/callback-transport: ordinary factory, status schema and signature helpers
- @dot-bridge/callback-transport/owner-message-experiment: explicitly bounded owner experiment
- @dot-bridge/callback-transport/owner-scoped-proxy: explicit continuous owner policy

The tested integration uses Node 24.15–24.x. The shared ordinary transport needs
Node 22 or newer; native proxy/owner integration is tested on Node 24.19.0.
Platform-specific private-file and process supervision live in dot-bridge-platform
and are unchanged by this package.

## Ordinary callback API

makeCallbackTransport(options) returns send(url, request) and send.preflight().
Construction and preflight perform no DNS or HTTP. Request method is POST only;
request hosts must be an exact DNS-host list, and beforeConnect is mandatory.
Only webhook signature/content headers are forwarded. Default request/response
caps are 262144 bytes, headers 8192 bytes/32 pairs, and total timeout 10000 ms
(maximum 30000 ms). Responses are bounded; redirects are rejected, not followed.

Direct mode resolves every send, rejects any non-public or family-invalid answer,
pins one copied public address, and retains original-host TLS verification. No
alternate-address retry occurs. Socket remoteAddress is not destination proof.

With a configured proxy, the ordinary factory remains blocked with
proxy_policy_unverified before DNS or adapter invocation. Legacy managedAdapter
objects are accepted only for shape/compatibility checks; a callable send does
not make an unverified route ready. No environment flag or metadata property can
change this. The former managed/delegated_unverified ready status is removed.

Proxy selection preserves lowercase-before-uppercase HTTPS_PROXY and NO_PROXY
precedence. Unsupported proxy-only configurations cannot fall back to direct.
NO_PROXY is used as an application deny predicate, never a selector of direct
transport. Its IP/CIDR extension is project policy, not native Node semantics.

## Explicit owner-message experiment

makeOwnerMessageExperimentTransport requires approvedOwnerMessageExperiment:true,
channel qq or lark and an existing supported proxy configuration. The default
fixed-window mode requires deadlineMs no more than 15 minutes away. An explicit
waitForOwner:true mode instead omits deadlineMs and waits under authenticated
subscription leases, without a separate total waiting cutoff. The code option is not proof of user
approval. The calling session must first authenticate its subscription authority
and verify the incoming provider owner/app/tenant/private-chat identity.

For ordinary owner text, select acceptAnyOwnerText:true; there is no prescribed
phrase. expectedText is ignored in this mode. The default false retains optional
exact-text compatibility. Ordinary text uses the bridge's existing nonempty,
2000-JavaScript-character / 8000-UTF-8-byte bounds and rejects illegal controls or
lone surrogates. Text is preserved verbatim and is untrusted data, never permission
for unrelated actions. The whole request body remains capped at 8192 bytes.

The sender requires an exact successful challenge echo, locks one canonical full
HTTPS URL and subscription ID, then accepts only one matching channel event with
conversation=owner and the existing message metadata fields. Both attempt budgets
are consumed before connection and never replenished by errors or retries. There
is no redirect, direct fallback, automatic retry, or restart recovery allowance.
The original proxy fingerprint, hostname/suffix/wildcard NO_PROXY denies, strict
hostname TLS, bounds and cancellation are retained. Target DNS/public-IP and
IP/CIDR checks are not performed here: the proxy resolves the hostname and its
final address remains unverified.

send.preflight() describes only the scoped experiment. send.state() exposes fixed
lifecycle/attempt fields without URL, text or credentials; send.close() revokes it.
In fixed-window mode, readiness remains active until expiry/close so the
separately guarded fixed reply can complete after the event. In waitForOwner mode,
readiness begins false with reason awaiting_subscription; no lease is not an
expired lease. An elapsed lease reports scope_expired, and explicit close reports
scope_closed. These blocked states keep unverified destination binding and do
not claim network checks. Ordinary proxy policy remains proxy_policy_unverified.
Only the authenticated calling session may call
send.renewLease(validUntil), after checking the fixed principal, complete callback
URL and signing secret. The transport itself does not authenticate those values.
Waiting may resume after an expired lease, but no callback is sent while expired.
Renewal keeps the same URL/subscription binding and cannot repeat the challenge.
After the first event attempt, renewal is refused and readiness expires at the
earlier of that lease and the event's original reply_deadline. The session must
also guard provider replies, stop business ingress without an active subscription,
and handle shutdown and renewal. Closing the sender permanently revokes it.
Neither mode replenishes its one-event budget.
The 10-second per-request deadline covers initial/final asynchronous authorization
as well as transport. Cancellation is rechecked after awaited races.

A trusted persistence owner may construct waitForOwner mode with restoredState
containing exactly url, subscription_id, valid_until, challenge_verified,
event_attempted, event_accepted and closed. This is a code-only import of an
already successful subscription; challenge_verified must be true. The factory
performs no storage or network I/O and does not prove checkpoint authenticity,
callback ownership, or final destination IP. The caller must decrypt and validate
its stored checkpoint against the same owner/app scope before constructing it.
The signing secret and message body are not inputs to this transport checkpoint.

Restoration consumes the challenge budget and preserves the original complete
URL, subscription ID, absolute expiry and event-attempt budget. valid_until must
be the persisted earlier subscription/message deadline, never a new duration
computed at restart. An attempted event with no accepted acknowledgement restores
closed; an accepted event cannot be resent or renewed. The persistence owner must
also retain the provider reply-attempt budget and close sent, uncertain or revoked
scopes. Only expired waiting scopes with no attempted event may authenticate and
renew. Before any callback or provider attempt, the session must durably record
that attempt; a crash or write failure must never restore a spent budget.

ownerMessageExperimentStatus(sender, proxyEnv) recognizes only this factory's
instances. Unknown or forged functions return null; proxy changes or scope expiry
block recognized instances. The optional connect/now hooks are trusted offline
test seams, not environment-selected modules. A real launcher uses the native core
and trusted clock. Factory identity alone does not attest a supplied test hook.

## Continuous owner-scoped proxy policy

makeOwnerScopedProxyTransport({channel,proxyEnv}) uses the same native forced
CONNECT/TLS implementation. The formal launcher selects this fixed module only
for an explicitly configured owner-scoped mode; it does not change the ordinary
factory or turn the single-message experiment into an unlimited sender.

Each beforeConnect authorization gate must return exactly principal, url,
subscription_id, expires and verified. The principal must be the configured
Tunnel owner, the complete URL and ID must match this request, and the lease
must remain current. Events require verified:true from the existing authenticated
subscription Store. A challenge may use verified:false while that same owner
subscription is being verified. The sender rechecks the gate before connection
operations and after the response. The caller must enforce the stored owner,
active subscription, epoch/generation, job lease and immutable message deadline.
The snapshot is a trusted code contract, not authentication by itself; neither
it nor successful TLS proves the callback belongs to a platform or has a public
final destination IP. That residual policy remains explicit at activation.

The sender accepts multiple distinct owner events with one callback in flight.
It records event IDs before beginning the connection and refuses repeat attempts.
An event attempted without a usable acknowledgement yields delivery_uncertain;
redirects and non-success responses never trigger a fallback or automatic retry.
HTTP 410 is returned to the existing bridge so it can revoke the subscription.
request_busy and capacity_exceeded are explicit pre-attempt refusals that may be
rescheduled locally. The cache is bounded by maxTrackedEvents (default 10000),
retains IDs until their original reply deadline and rejects expired payloads.
The existing durable Store must prevent replay after restart, keep message
metadata immutable, and mark interrupted processing events uncertain in this
mode. It owns rate, queue and persistence policies; there is no second outbox.

owner_scoped_proxy readiness means the selected transport dependency is available;
active subscription and provider readiness remain separate bridge status fields.
It always reports destination_binding:unverified and network_checked:false.
No helper reads files, configures credentials, logs bodies, starts a service or
asserts production final-IP safety. The native proxy/TLS core and ten-second total
request deadline remain shared with the already tested connection path.

## Truthful status

The closed six-field schema keeps ready, mode, reason, proxy_configured,
destination_binding and network_checked. Ordinary modes are direct or blocked.
The separate owner_single_message_proxy and owner_scoped_proxy modes expose only
their selected policy scope,
with destination_binding:unverified and network_checked:false. It does not claim
production final-IP safety, real delivery, provider readiness or a current-dot wake.

The native internal connection core is reused by the explicit experiment. It
contains no temporary observation hooks, diagnostic publisher, log persistence,
callback capture, or environment-selected implementation.

## Verification

From the core repository, run:

    node --test --test-concurrency=1 packages/dot-bridge-transport/test/*.test.js
    node --test --test-concurrency=1 test/*.test.js
    npm test
    npm run check

Tests use inert doubles and bounded loopback fixtures, including synthetic TLS
certificates. They never contact providers or real callbacks. Native TLS tests
need an installed OpenSSL executable. Source-copy checks preserve original source
hashes and record each reviewed packaged adaptation; no runtime diagnostic or
private deployment material belongs in the package.
