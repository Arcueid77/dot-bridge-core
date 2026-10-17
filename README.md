# dot-bridge-core

Canonical provider-independent shared code for the existing dot bridges. Node
>=24.15 and <25. The repository builds the versioned `@dot-bridge/core` package;
deployments install its reviewed tarball without cloning this source repository.
No IM SDK, model API, credentials, database, callback subscription or Tunnel
runtime key is included in this package.

Exports:

- `@dot-bridge/core/transport`: the existing strict callback transport.
- `@dot-bridge/core/platform`: Windows native handles and mode locks.
- `@dot-bridge/core/platform/private-files.js`: canonical descriptor-relative Linux
  private file/database leases and the matching Windows branch, also used by
  standalone deployment status and backup validation scripts.
- `@dot-bridge/core/router`: registered-channel loopback MCP aggregation.
- `@dot-bridge/core/audio`: optional local speech transcription for hosts that
  cannot consume native MCP audio.

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

Local transcription is opt-in and currently requires Linux. Install a reviewed
`whisper-cli` build and a multilingual Whisper model from the upstream
[whisper.cpp project](https://github.com/ggml-org/whisper.cpp). Keep the executable,
model and parent directories root-owned and not writable by the service user.
The backend environment selects them with `DOT_BRIDGE_AUDIO_TRANSCRIPTION=local-whisper`,
`DOT_BRIDGE_WHISPER_BINARY=/protected/runtime/whisper-cli` and
`DOT_BRIDGE_WHISPER_MODEL=/protected/runtime/ggml-base.bin`.
Use the existing private `BRIDGE_LOCK_DIRECTORY` for both backends; one
nonblocking lock serializes recognition across them. FFmpeg, prlimit and flock
must be installed under `/usr/bin`. No API key or external transcription
service is used. The host's original dot still generates the response.

Audio travels through bounded memory pipes, never a temporary media file.
Recognition uses one CPU thread, a virtual address-space ceiling of 1.5 GiB and at most
28 seconds of wall time. Input is limited to 8 MiB and 120 seconds; decoded
silence, busy/absent runtimes, unsupported formats and timeouts return
`extraction_status:unsupported`. The bridge keeps the native audio result and
must ask for clearer/shorter speech or text when neither audio nor transcription
is usable. Reference transcription can contain errors and is untrusted content.
Runtime programs receive no application credentials or proxy environment.

`provenance/extraction.json` records the reviewed source revision and unchanged
shared file hashes. Provider-specific contracts now belong to their IM adapters.
Actual adapter/router integration runs in the Feishu repository without optional
sibling-path skips. The QQ repository retains thin two-adapter compatibility
exports and regression fixtures for the old finite-window development launcher;
these are not required by Feishu or the persistent VPS deployment.
