# dot-bridge-core

Canonical provider-independent shared code for the existing dot bridges. Node
>=24.15 and <25. The repository builds the versioned `@dot-bridge/core` package;
deployments install its reviewed tarball without cloning this source repository.
No IM SDK, model API, credentials, database, callback subscription or Tunnel
runtime key is included in this package.

Exports:

- `@dot-bridge/core/transport`: the existing strict callback transport.
- `@dot-bridge/core/platform`: private files, Windows native handles and mode locks.
- `@dot-bridge/core/router`: registered-channel loopback MCP aggregation.

The executable in each IM repository registers its trusted adapter in code. The
adapter owns tool/event schemas, argument and result projection, capabilities,
per-tool budgets and provider preflight details. The router does not fetch or load
modules described by callers or environment variables. It never forwards upstream
descriptions, credentials, identities or arbitrary errors.

`TUNNEL_CHANNELS` selects installed adapters (default: all explicitly registered
by that executable). `TUNNEL_LIVE_CHANNELS` is an independently validated subset.
Omitted adapters require no key, port, readiness service or network connection.
Ingress and every configured upstream use separate service keys. All targets
remain fixed loopback endpoints. Official Tunnel and dot subscription management
remain external to core; no model API bot or replacement Tunnel is created.

For standalone Feishu, its executable registers only `lark`. Install the Feishu
repository with its lockfile and included core tarball, then run:

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node --env-file=/protected/router.env scripts/run-tunnel-router.js --confirm-live
```

For development and offline regression in this repository:

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm pack --ignore-scripts
```

Private ownership checks, direct HTTPS/DNS/IP pinning, original-host TLS checks,
no redirects, no automatic mutation retry and uncertain-delivery behavior are
preserved. Installed copies are immutable releases of one canonical source;
consuming repositories must not maintain separate shared implementations.

`provenance/extraction.json` records the reviewed source revision and unchanged
shared file hashes. Provider-specific contracts now belong to their IM adapters.
Actual adapter/router integration runs in the Feishu repository without optional
sibling-path skips. The QQ repository retains thin two-adapter compatibility
exports and regression fixtures for the old finite-window development launcher;
these are not required by Feishu or the persistent VPS deployment.
