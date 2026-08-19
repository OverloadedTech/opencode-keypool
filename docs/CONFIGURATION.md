# Configuration reference

`~/.config/opencode-route/config.json` (or `--config <path>`).
`$XDG_CONFIG_HOME` is respected. The file is created by `oc-route tui`
with `0600` permissions.

## Top-level fields

| Field | Default | Meaning |
|---|---|---|
| `port` | `4777` | Loopback port the daemon listens on. Changing it requires a daemon restart. |
| `cooldown_seconds` | `60` | How long an entry cools after `max_failures` consecutive failures. |
| `max_failures` | `5` | Consecutive failures (5xx/network) before an entry goes on cooldown. |
| `rate_limit_cooldown_seconds` | `60` | Per-entry cooldown after a single `429` from that entry. |
| `auth_fail_cooldown_seconds` | `1800` | Per-entry cooldown after `401`/`403` — a bad key rarely recovers quickly. |
| `provider_breaker_trigger` | `0` (off) | Number of *distinct* entries rate limited within a window that opens the provider-wide circuit breaker. `0` disables the breaker. |
| `provider_breaker_seconds` | `900` | How long the breaker stays open; the never-stop loop waits this out and retries. |
| `retry_backoff` | `[0.4, 0.8, 1.5, 3.0]` | Seconds of sleep between retries (index clamps at the last value). |
| `upstream_timeout_seconds` | `600` | Full-request timeout for upstream calls (streams can run long). |
| `exhaust_wait_timeout_seconds` | `0` | Total time a request may hold while *all* entries are cooling before it fails with `502 AllEntriesFailed`. `0` = wait forever (never-stop rotation). |
| `max_retry_after_seconds` | `86400` | Cap applied to an upstream `retry-after` header when scheduling an entry's cooldown. Prevents a bogus/hostile `retry-after` from parking an entry indefinitely. |
| `pools` | `[]` | Ordered pools, one model per pool is exposed to opencode as `route/<pool id>`. |

## Pools

```jsonc
{
  "id": "default",     // exposed to opencode as route/default
  "label": "My pool",  // human-readable name shown in the TUI and opencode
  "entries": [...]     // tried in order
}
```

`id` must match `^[a-z0-9][a-z0-9_.-]{0,63}$`.

## Entries

One entry is one `(provider, model, API key)` combination.

| Field | Values | Meaning |
|---|---|---|
| `id` | string | Unique within the pool; the TUI assigns `entry-N` automatically. |
| `label` | string | Shown in the TUI and in the `x-route-entry` response header. |
| `adapter` | `openai` · `azure` · `anthropic` | Wire protocol used toward the upstream. |
| `base_url` | URL | Prefix before the API path. For `openai`/`azure` the daemon POSTs to `<base_url>/chat/completions`; for `anthropic` to `<base_url>/messages` (or `<base_url>/v1/messages` if the base does not end in `/v1`). |
| `model` | string | Upstream model id (e.g. `deepseek-v4-flash-free`, `gpt-5.2`, `claude-sonnet-4-6`, or an Azure deployment name). |
| `api_key` | string | Upstream credential. |
| `auth` | `bearer` · `api-key` · `none` | How the key is attached: `Authorization: Bearer` (default), `api-key` header (Azure), or no auth (local Ollama). |
| `api_version` | string | Azure only: `api-version` query parameter. |
| `enabled` | bool | Disabled entries are skipped and kept in the list. |
| `proxy` | URL | Optional HTTP/SOCKS5 proxy all upstream traffic for this entry goes through, e.g. `http://host:3128`, `http://user:pass@host:3128`, `socks5://host:1080`, `socks5://user:pass@host:1080`. HTTPS upstreams use CONNECT tunneling. |
| `headers` | object | Extra headers sent to the upstream, e.g. `{"HTTP-Referer": "https://opencode.ai/"}`. |

## Provider presets (TUI)

| Preset | Adapter | Base URL |
|---|---|---|
| `opencode-zen` | openai | `https://opencode.ai/zen/v1` |
| `openai` | openai | `https://api.openai.com/v1` |
| `anthropic` | anthropic | `https://api.anthropic.com/v1` |
| `azure` | azure | (user-provided resource/deployment URL) |
| `openrouter` | openai | `https://openrouter.ai/api/v1` |
| `deepseek` | openai | `https://api.deepseek.com` |
| `groq` | openai | `https://api.groq.com/openai/v1` |
| `mistral` | openai | `https://api.mistral.ai/v1` |
| `xai` | openai | `https://api.x.ai/v1` |
| `google` | openai | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `together` | openai | `https://api.together.xyz/v1` |
| `ollama` | openai | `http://127.0.0.1:11434/v1` |
| `custom` | openai | (user-provided) |

## Example: layered fallback

Best key first, then another key, then a cheaper model, then a different
provider — one pool, four entries:

```jsonc
"pools": [{
  "id": "default",
  "label": "Layered fallback",
  "entries": [
    { "adapter": "openai", "base_url": "https://opencode.ai/zen/v1", "model": "big-pickle", "api_key": "sk-zen-1", "auth": "bearer", "enabled": true },
    { "adapter": "openai", "base_url": "https://opencode.ai/zen/v1", "model": "big-pickle", "api_key": "sk-zen-2", "auth": "bearer", "enabled": true },
    { "adapter": "openai", "base_url": "https://opencode.ai/zen/v1", "model": "deepseek-v4-flash-free", "api_key": "sk-zen-2", "auth": "bearer", "enabled": true },
    { "adapter": "anthropic", "base_url": "https://api.anthropic.com/v1", "model": "claude-sonnet-4-6", "api_key": "sk-ant-...", "auth": "bearer", "enabled": true }
  ]
}]
```

## Why switching keys does not help on the Zen free tier

The OpenCode Zen backend is open source (`opencode-zen` → the console app's
`routes/zen/util/handler.ts`). Its rate limiting for the free models works
like this:

- Models with `allowAnonymous` (including the `*-free` models and
  `big-pickle`) are limited **per IP address**, not per API key:
  `createIpRateLimiter` counts requests in a per-IP daily bucket
  (`ipRateLimiter.ts`), and default free models also have a per-IP
  *lifetime* cap (7× the daily limit). The API key is only used for
  auth/billing identity; sending no key or `Bearer public` is treated as
  anonymous.
- The IP is taken from the `x-real-ip` header set by the edge proxy; IPv6
  is truncated to its first four segments (a `/64`). Via a per-entry
  proxy/VPN, this is that entry's egress IP.
- A `429` for an IP-limited model is `FreeUsageLimitError` and carries a
  `retry-after` header equal to the number of seconds until **UTC
  midnight** — exactly when that IP's daily bucket resets. route honors
  this header and parks the entry until then (capped at
  `max_retry_after_seconds`).
- While an IP is still inside its 7× lifetime window the effective daily
  cap is doubled (`dailyLimit * 2`); after the lifetime cap is reached it
  drops to `dailyLimit`.
- Some models also configure a `rateLimit` whose daily bucket key is
  `<date><first two letters of the model id>` — so on one IP,
  `deepseek-v4-flash-free` and other `de*` models can share a bucket.
- Trial-provider promo tokens are tracked per IP in the database
  (`trialLimiter.ts`).
- Only non-anonymous models use a per-key limiter (1000 requests/minute
  per key by default, `keyRateLimiter.ts`).

So on one machine all your keys share the same IP bucket: when you hit the
limit on key 1, key 2 on the same or another free model is limited too —
exactly the symptom described. Switching devices or networks changes the
IP and gives fresh buckets.

The route countermeasure is **per-entry `proxy`**: give each entry its
own egress IP (a different VPN, VPS, or proxy per account), and each key
gets its own limit bucket. With `exhaust_wait_timeout_seconds: 0` the
rotation never gives up: when every entry's IP is cooling down, the daemon
waits for the earliest `retry-after` (usually the next UTC midnight) and
auto-resumes the moment one bucket frees. Example with two accounts and
two IPs:

```jsonc
"entries": [
  { "adapter": "openai", "base_url": "https://opencode.ai/zen/v1", "model": "big-pickle", "api_key": "sk-zen-1", "auth": "bearer", "enabled": true, "proxy": "socks5://vpn-a.example:1080", "headers": {} },
  { "adapter": "openai", "base_url": "https://opencode.ai/zen/v1", "model": "big-pickle", "api_key": "sk-zen-2", "auth": "bearer", "enabled": true, "proxy": "socks5://vpn-b.example:1080", "headers": {} }
]
```

Without per-entry proxies, the failover still helps with per-key issues
(bad keys, key-scoped limits) but cannot help with limits keyed on your IP.

## Runtime state

Cooldowns, failure counters, sticky-session pins and the circuit breaker
live in the daemon's memory only. They reset on daemon restart; the config
file itself is never rewritten by the daemon (the TUI is the only writer).
The daemon hot-reloads the config file within ~2 seconds of a save.

## Environment variables

| Variable | Effect |
|---|---|
| `XDG_CONFIG_HOME` | Base for `opencode-route/config.json` (default `~/.config`). |
| `XDG_STATE_HOME` | Base for the pid file and daemon log (default `~/.local/state`). |
| `BUN_INSTALL` | Fallback location to find `bun` when it is not on `PATH`. |
