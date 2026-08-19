# opencode-route

Per-entry IP/proxy rotation, provider failover and model fallback for
[opencode](https://opencode.ai), configured from a terminal UI.

```text
opencode ──► route daemon ──► entry 1: proxy/IP A ── (rate limited) ──┐
             127.0.0.1:4777         entry 2: proxy/IP B  ◄────────────┘
              (OpenAI-compatible     entry 3: OpenAI GPT
               endpoint)             entry 4: Anthropic Claude
                                     ...
```

Every request opencode sends goes through a tiny local proxy that picks one
`(provider, model, API key, egress proxy)` combination — an **entry** — and
transparently retries the next one when an entry fails:

- **Per-entry rotation** — a failed or rate-limited entry is cooled down
  until its upstream `retry-after` (for Zen free models that is the next
  UTC midnight) and the request retries with the next entry.
- **Model fallback** — when all entries of your favorite model fail, the
  request moves on to other models.
- **Provider fallback** — entries can mix OpenAI-compatible providers
  (OpenAI, OpenRouter, DeepSeek, Groq, Mistral, xAI, Google, OpenCode Zen,
  Azure, Ollama, ...) and **native Anthropic** (the proxy translates
  requests, responses, tool calls and streaming on the fly).
- **Per-entry egress proxies** — each entry can route its upstream traffic
  through its own HTTP/SOCKS5 proxy, so every entry can come from a
  different IP. This is the way around IP-based free-tier limits (see
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md#why-switching-keys-does-not-help-on-the-zen-free-tier)).
- **Sticky sessions** — each opencode session keeps using the entry that
  works, instead of spreading one conversation over several accounts.
- **Never-stop failover** — a request only "stops" when every entry is
  cooling down, and even then it waits for the earliest `retry-after` and
  auto-resumes the moment an entry clears, retrying from the first entry
  to the last. An optional circuit breaker can pause the pool when several
  distinct entries are rate limited at once (off by default).
- **TUI configuration** — `oc-route tui` manages pools, entries, proxies
  and settings with a zero-dependency terminal UI.

It is designed to be **global on a device**: one config in
`~/.config/opencode-route/`, one daemon, and every opencode session on the
machine benefits from it. Fully open source (MIT).

---

## Install

```bash
# requires bun >= 1.2 (https://bun.sh)
git clone https://github.com/<you>/opencode-route
cd opencode-route
bun install

# run the configuration TUI (creates ~/.config/opencode-route/config.json)
bun run src/cli.ts tui
# or: bunx --bun oc-route tui          (once published on npm)
```

Then register the opencode plugin:

```bash
bun run src/cli.ts install --self        # registers this checkout's plugin
# oc-route install                      # registers the npm package
```

Restart opencode. The `route` provider appears with one model per pool
(`route/default`, ...). Pick it with `/models` or in Settings. The plugin
also auto-starts the daemon when opencode launches if it is not running.

You can also run the daemon explicitly:

```bash
oc-route start          # background daemon (log: ~/.local/state/opencode-route/route.log)
oc-route status         # health, breakers, entries
oc-route stop
```

---

## 60-second setup

```text
$ oc-route tui
```

1. Press `N` to create a pool (e.g. `default`).
2. Press `n` to add an entry. Fill the form:
   - label: anything (`Zen key 1`)
   - preset: `opencode-zen`, `openai`, `anthropic`, `azure`, `openrouter`,
     `deepseek`, `groq`, `mistral`, `xai`, `google`, `together`, `ollama`,
     `custom` (presets prefill the base URL)
   - base_url: auto-filled by the preset
   - model: the upstream model id
   - api_key: the key for this provider
3. `Tab` to `[Save]`, press `Enter`. Repeat for every key you have.
4. Order matters: entries are tried top to bottom. Use `Ctrl+Up`/`Ctrl+Down`
   to reorder — best key first, fallbacks below.
5. Press `q` to save and quit, then `oc-route install --self` and restart
   opencode.

The status dot per entry comes live from the daemon: `●` healthy,
`○` cooling down, `!` last request failed, `·` disabled.

---

## How failover works

Entries are tried in list order. For each request:

| Upstream result | Route behavior |
|---|---|
| `2xx` | Success. The session stays sticky on this entry. |
| `401` / `403` | Auth failure. Entry cooled for `auth_fail_cooldown_seconds` (default 30 min), request retries the next entry. |
| `429` | Entry cooled for `rate_limit_cooldown_seconds` (default 60 s), request retries the next entry. |
| `5xx` / network error | Failure counted. After `max_failures` (default 5) the entry cools for `cooldown_seconds` (default 60 s). Request retries the next entry. |
| `4xx` (other) | Passed through unchanged — retrying another key would not help. |
| `2xx` then stream breaks mid-way | Too late to retry (bytes already streamed); an error frame is sent and opencode surfaces it. |
| All entries cooling | The request **holds** until the earliest cooldown/`retry-after` expires, then retries the pool from the first entry again. It only fails after `exhaust_wait_timeout_seconds` (default `0` = wait forever). |

**Circuit breaker** (optional, off by default): set `provider_breaker_trigger`
to a positive number to pause the whole pool for `provider_breaker_seconds`
when that many *distinct* entries get rate limited within a short window.
With the never-stop wait loop, this only adds a wait before the pool retries —
useful when the upstream limits the whole server/IP and burning keys would
be wasteful.

The breaker, cooldowns, entry status and counters are live at
`http://127.0.0.1:<port>/health`.

### Why sticky sessions

opencode sends an `x-session-affinity` header with every LLM request. The
daemon remembers which entry served a session and keeps using it. Without
this, a single conversation would round-robin across keys — upstreams can
flag one machine using many accounts.

---

## Command reference

```text
oc-route tui                 configure everything in a TUI (default command)
oc-route serve [--port N]    run the rotation proxy in the foreground
oc-route start [--wait]      start the daemon in the background
oc-route stop                stop the daemon
oc-route restart             restart the daemon
oc-route status              daemon health + pools + entries
oc-route health              raw /health JSON
oc-route install [--self]    register the plugin in ~/.config/opencode/opencode.json
oc-route uninstall           remove the plugin registration
oc-route doctor              diagnose bun, daemon, config and opencode wiring
oc-route list                pools and entries (keys redacted)
oc-route version
```

Global flag: `--config <path>` to use an alternative config file.

---

## Configuration

Config lives in `~/.config/opencode-route/config.json` (created by the
TUI; `$XDG_CONFIG_HOME` respected). API keys are stored there with `0600`
permissions — treat the file like a keyring.

```jsonc
{
  "port": 4777,
  "cooldown_seconds": 60,
  "max_failures": 5,
  "rate_limit_cooldown_seconds": 60,
  "auth_fail_cooldown_seconds": 1800,
  "provider_breaker_trigger": 0,
  "provider_breaker_seconds": 900,
  "retry_backoff": [0.4, 0.8, 1.5, 3.0],
  "upstream_timeout_seconds": 600,
  "exhaust_wait_timeout_seconds": 0,
  "max_retry_after_seconds": 86400,
  "pools": [
    {
      "id": "default",
      "label": "My pool",
      "entries": [
        {
          "id": "zen-1",
          "label": "Zen key 1",
          "adapter": "openai",
          "base_url": "https://opencode.ai/zen/v1",
          "model": "deepseek-v4-flash-free",
          "api_key": "sk-...",
          "auth": "bearer",
          "api_version": "",
          "enabled": true,
          "proxy": "socks5://127.0.0.1:1080",
          "headers": {}
        },
        {
          "id": "claude",
          "label": "Anthropic fallback",
          "adapter": "anthropic",
          "base_url": "https://api.anthropic.com/v1",
          "model": "claude-sonnet-4-6",
          "api_key": "sk-ant-...",
          "auth": "bearer",
          "api_version": "",
          "enabled": true,
          "proxy": "",
          "headers": {}
        }
      ]
    }
  ]
}
```

Details: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

### Azure

Use preset `azure`, set `base_url` to
`https://<resource>.openai.azure.com/openai/deployments/<deployment>`,
`auth` to `api-key` and optionally `api_version` (e.g. `2025-04-01-preview`).

### Anthropic

Entries with `adapter: "anthropic"` talk the native `/v1/messages` API. The
daemon converts opencode's OpenAI-style chat completions into Anthropic
messages and back — text, images (base64/URL), PDFs, tools, tool calls,
streaming, usage. `overloaded_error` is treated as a rate limit.

### Per-entry proxies

Set `proxy` on an entry to route its upstream requests through an HTTP
(CONNECT) or SOCKS5 proxy, e.g. `http://user:pass@host:3128` or
`socks5://127.0.0.1:1080`. Each entry can use a different proxy, so each
key egresses from its own IP — the practical way around IP-based free-tier
limits. Extra upstream headers can be set with `headers` (e.g. `{"HTTP-Referer": "https://opencode.ai/"}`).

---

## Running as a user service (systemd)

```ini
# ~/.config/systemd/user/opencode-route.service
[Unit]
Description=opencode-route rotation proxy

[Service]
ExecStart=%h/.bun/bin/bun /path/to/opencode-route/src/cli.ts serve
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now opencode-route
```

The plugin detects the running daemon and never starts a second one.

---

## Security notes

- The daemon binds `127.0.0.1` only. Never expose it to a network.
- Keys are stored in a `0600` config file under `~/.config/opencode-route/`.
- opencode only needs a dummy key (`route`) to talk to the local proxy.
- Entry labels are returned in response headers (`x-route-entry`) for
  debugging; keys are never logged.

---

## Development

```bash
bun install
bun run typecheck
bun test          # engine, adapters and end-to-end server tests (no mocks)
```

Architecture and the HTTP surface: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Runtime must stay dependency-free.

## License

MIT — see [LICENSE](LICENSE)
