# Architecture

opencode-route is a local, single-user proxy plus an opencode plugin. It
has zero runtime dependencies and runs on Bun.

```text
┌──────────────┐   OpenAI-compatible HTTP   ┌─────────────────────────────┐
│ opencode TUI │ ─────────────────────────► │ route daemon              │
│              │  x-session-affinity header │ 127.0.0.1:4777 (loopback)   │
│  plugin.ts   │                            │                             │
│  registers   │                            │  server.ts   routes         │
│  provider    │                            │  engine.ts   rotation       │
│  "route"     │                            │  adapters/   wire formats   │
└──────────────┘                            └──────────┬──────────────────┘
                                                       │
              ┌────────────────────────────────────────┼───────────────────┐
              │ openai adapter    │ azure adapter      │ anthropic adapter │
              │ /chat/completions │ /chat/completions  │ /v1/messages      │
              │ Authorization     │ api-key + version  │ x-api-key         │
              ▼                   ▼                    ▼                   │
         OpenAI-compatible    Azure OpenAI       Anthropic API             │
         (OpenAI, Zen,         (deployments)     (native, translated)     │
          OpenRouter, Groq,                                                 │
          DeepSeek, ...)                                                    │
```

## Pieces

| Module | Role |
|---|---|
| `src/plugin.ts` | opencode plugin. Reads the config, auto-starts the daemon, registers a `route` provider (`@ai-sdk/openai-compatible`, baseURL `http://127.0.0.1:<port>/v1`, `timeout: false`, no `chunkTimeout`) with one model per pool. |
| `src/server.ts` | Bun HTTP server. Endpoints below. Owns the never-stop retry loop, streaming pipes and config hot-reload (mtime polling, ~2 s). |
| `src/engine.ts` | PoolEngine: pick logic (order, sticky sessions, skip sets), failure counters, per-entry cooldowns (honoring upstream `retry-after`, capped by `max_retry_after_seconds`), optional circuit breaker, exhaustion wait estimation, stats. |
| `src/adapters/openai.ts` | Builds OpenAI-compatible requests (Bearer / `api-key` / no auth) and passes responses and SSE streams through unchanged. |
| `src/adapters/anthropic.ts` | Translates OpenAI chat.completions to Anthropic `/v1/messages` and back: messages, system prompts, images, PDFs, tools, tool calls, streaming events (`message_start` → role chunk, `text_delta` → content, `input_json_delta` → incremental `tool_calls`, `message_delta` → `finish_reason` + usage). |
| `src/proxy.ts` | Per-entry egress tunnels: HTTP CONNECT and SOCKS5 (with auth) via `node:net`/`node:tls`/`node:http(s)`, zero dependencies. |
| `src/config.ts` | Config schema, sanitization, atomic save (`tmp` + rename, `0600`), provider presets. |
| `src/daemon.ts` | Daemon lifecycle shared by CLI and plugin: pid file, log, spawn/stop, health polling. |
| `src/tui.ts` | Dependency-free ANSI TUI: raw-mode input queue, arrow navigation, inline form editing, live health polling. |
| `src/cli.ts` | Command dispatch (`tui`, `serve`, `start`, `stop`, `status`, `health`, `install`, `uninstall`, `doctor`, `list`). |

## HTTP surface (daemon)

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | The proxy core. `model` selects the pool. Retries across entries per the failover rules. Supports `stream: true` (SSE). |
| `GET /v1/models` | Lists pools as models (`route/<id>`). |
| `GET /health` | Live status: breaker, per-entry cooldowns/failures/errors, counters, pool list. |
| `GET /stats` | Breaker + counters only. |

Debug headers on responses: `x-route-entry` (entry label) and
`x-route-pool` (pool id) on non-stream responses.

## Request lifecycle

```text
POST /v1/chat/completions
  │
  ├─ body.model ─► pool lookup (404 with available pools if unknown)
  ├─ session id from x-session-affinity | x-opencode-session | x-session-id
  │
  └─ never-stop loop (until success or wait-budget exhaustion)
       │
       ├─ engine.pick(pool, session, tried)   → entry
       │     sticky entry if still usable, else first enabled entry
       │
       ├─ no usable entry (all cooling / breaker open):
       │     wait until the earliest cooldown expires (or breaker clears),
       │     clear the tried set, and retry from the first entry.
       │     Fails with 502 only when exhaust_wait_timeout_seconds runs out.
       │
       ├─ adapter.build(entry, body)          → upstream request
       ├─ fetch (or fetchViaProxy when entry.proxy is set)
       │
       ├─ non-2xx: classify
       │     auth     → onAuthFailure  (long cooldown)   → retry next entry
       │     rate     → onRateLimit    (short cooldown)  → retry
       │     upstream → onUpstreamError (failure counter) → retry
       │     client   → passthrough response, no retry
       │
       └─ 2xx:
             stream  → pipe SSE (openai passthrough / anthropic translation)
                       mid-stream failure → error frame + [DONE]
             json    → adapter.fromUpstream → OpenAI chat.completion shape
```

## Failover semantics

- **Order**: entries are tried top to bottom. Reorder in the TUI.
- **Sticky sessions**: the first entry that succeeds is remembered per
  `x-session-affinity`. Sticky pins are dropped when the entry fails, is
  disabled, or goes on cooldown.
- **Per-entry cooldowns**: `429` → `rate_limit_cooldown_seconds`;
  `401/403` → `auth_fail_cooldown_seconds`; N consecutive 5xx/network
  failures → `cooldown_seconds`.
- **Never-stop exhaustion wait**: when every entry is cooling, the request
  holds until the earliest cooldown expires (or the breaker clears), then
  retries from the first entry. It only gives up after
  `exhaust_wait_timeout_seconds` (`0` = hold forever). Streaming requests
  hold before the first byte; opencode is configured without
  `chunkTimeout` and with `timeout: false`, so nothing aborts the wait.
- **Circuit breaker**: optional (`provider_breaker_trigger > 0`). Distinct
  entries rate limited within a 10-minute window pause the pool for
  `provider_breaker_seconds`; the exhaustion wait simply waits it out.
- **No retry**: 4xx client errors pass through (a different key would not
  fix the request), and streams that already delivered bytes cannot be
  replayed.

## Egress proxies

Entries may declare `proxy` (`http://` or `socks5://`). The tunnel is built
in `src/proxy.ts` with only node built-ins: HTTP CONNECT or a SOCKS5
handshake over `node:net`, optional TLS wrap, then the request is issued
through `node:http(s)` with a custom `createConnection`. Each entry can
therefore egress from a different IP, which is how IP-keyed free-tier
limits are separated per key.

## Why a proxy instead of pure plugin hooks

opencode's plugin API can register providers and mutate config, but it
cannot intercept or replay a provider HTTP request. Failover needs to sit
between the AI SDK and the upstreams, so the proxy is the smallest honest
design: opencode talks OpenAI-compatible HTTP to a loopback port, exactly
like any other provider. The plugin's job is discovery (register the
provider + models) and lifecycle (auto-start the daemon).

## Config hot-reload

The daemon polls the config file mtime every 2 s and swaps the config +
engine view on change. Runtime state (cooldowns, counters) is preserved for
entries that still exist and dropped for removed ones. A changed `port`
only applies after a restart.
