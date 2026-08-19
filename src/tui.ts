import type { PoolConfig } from "./config.ts"

export type HealthEntry = {
  id: string
  pool: string
  label: string
  model: string
  adapter: string
  enabled: boolean
  cooldown: number
  failures: number
  last_error: string
  last_used_at: number
  successes: number
}

export type Health = {
  ok: boolean
  version?: string
  uptime_seconds?: number
  port?: number
  pools?: { id: string; label: string; entries: number }[]
  breaker?: { active: boolean; remaining: number; reason: string }
  entries?: HealthEntry[]
  stats?: { requests: number; failovers: number; auth_failures: number; rate_limits: number; upstream_errors: number }
}

const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"
const REVERSE = "\x1b[7m"

export type Env = {
  isTTY: boolean
  write(text: string): void
  readKey(): Promise<string>
  cols: number
  rows: number
  onResize(cb: () => void): void
}

export async function runTui(
  initial: PoolConfig,
  save: (config: PoolConfig) => void,
  health: () => Promise<Health | null>,
  env: Env,
): Promise<void> {
  if (!env.isTTY) {
    console.log("oc-route tui requires an interactive terminal.")
    return
  }
  process.stdin.setRawMode(true)
  const state = {
    screen: "main" as "main" | "settings" | "help",
    poolIdx: 0,
    entryIdx: 0,
    health: null as Health | null,
    message: "",
    config: initial,
    form: null as FormState | null,
    settingsForm: null as SettingsForm | null,
    helpScroll: 0,
  }
  const render = () => env.write(renderScreen(state, env.cols, env.rows))
  env.onResize(render)
  const refreshHealth = async () => {
    const h = await health()
    if (h) state.health = h
    render()
  }
  void refreshHealth()
  const healthTimer = setInterval(refreshHealth, 2500)
  render()
  try {
    for (;;) {
      const key = await env.readKey()
      if (key === "\x03") break
      if (key === "\x1b[A") move(state, "up")
      else if (key === "\x1b[B") move(state, "down")
      else if (key === "\x1b[D") move(state, "left")
      else if (key === "\x1b[C") move(state, "right")
      else if (key === "\x1b[1;5A") moveEntry(state, "up")
      else if (key === "\x1b[1;5B") moveEntry(state, "down")
      else if (key === "\x7f" || key === "\x08") editBackspace(state)
      else if (key === "\x15") editClear(state)
      else if (key === "\x09") cycleFocus(state, "down")
      else if (key === "\x1b[Z") cycleFocus(state, "up")
      else if (key === "\r") activate(state, save)
      else if (key === "\x1b") {
        if (state.form) state.form = null
        else if (state.settingsForm) {
          state.settingsForm = null
          state.screen = "main"
        } else if (state.screen === "help") state.screen = "main"
      }
      else if (key === "q") {
        if (state.screen === "help" || state.form || state.settingsForm) {
          state.form = null
          state.settingsForm = null
          state.screen = "main"
        } else break
      }
      else if (state.form) formKey(state, key)
      else if (state.settingsForm) settingsKey(state, key)
      else mainKey(state, key, save)
      render()
    }
  } finally {
    clearInterval(healthTimer)
    process.stdin.setRawMode(false)
  }
}

type FlatItem = { pool: number; entry: number } | { pool: number }

function flatten(config: PoolConfig): FlatItem[] {
  const out: FlatItem[] = []
  config.pools.forEach((pool, poolIdx) => {
    out.push({ pool: poolIdx })
    pool.entries.forEach((_, entryIdx) => out.push({ pool: poolIdx, entry: entryIdx }))
  })
  return out
}

function move(state: State, dir: "up" | "down" | "left" | "right") {
  if (state.form) {
    formNavigate(state, dir)
    return
  }
  if (state.settingsForm) {
    settingsNavigate(state, dir)
    return
  }
  if (state.screen === "help") {
    if (dir === "down") state.helpScroll++
    if (dir === "up") state.helpScroll = Math.max(0, state.helpScroll - 1)
    return
  }
  const items = flatten(state.config)
  if (items.length === 0) return
  const pos = items.findIndex((item) => "entry" in item && item.pool === state.poolIdx && item.entry === state.entryIdx)
  const step = dir === "down" ? 1 : -1
  let next = (pos === -1 ? (dir === "down" ? -1 : 0) : pos) + step
  if (next < 0) next = items.length - 1
  if (next >= items.length) next = 0
  const item = items[next]
  if (!item) return
  if ("entry" in item) {
    state.poolIdx = item.pool
    state.entryIdx = item.entry
  } else {
    state.poolIdx = item.pool
    state.entryIdx = -1
  }
}

function moveEntry(state: State, dir: "up" | "down") {
  if (state.form || state.settingsForm || state.screen !== "main") return
  const pool = state.config.pools[state.poolIdx]
  if (!pool) return
  if (state.entryIdx < 0) return
  const target = dir === "up" ? state.entryIdx - 1 : state.entryIdx + 1
  if (target < 0 || target >= pool.entries.length) return
  const entry = pool.entries.splice(state.entryIdx, 1)[0]
  if (!entry) return
  pool.entries.splice(target, 0, entry)
  state.entryIdx = target
  state.message = "entry order updated"
}

function activate(state: State, save: (config: PoolConfig) => void) {
  if (state.form) {
    const form = state.form
    const pool = state.config.pools[form.poolIdx]
    if (!pool) {
      state.form = null
      return
    }
    if (form.focus === form.fields.length) {
      const preset = PRESET_FOR_FORM[form.preset] ?? form.entry.adapter
      const entry = {
        ...form.entry,
        id: form.entry.id || newEntryIdFor(pool),
        label: form.entry.label || form.entry.model || "entry",
        adapter: preset,
        model: form.entry.model.trim(),
        base_url: form.entry.base_url.trim(),
        api_key: form.entry.api_key.trim(),
      }
      if (!entry.model) {
        state.message = "model is required"
        return
      }
      if (entry.adapter === "anthropic" && !entry.base_url) {
        entry.base_url = "https://api.anthropic.com/v1"
      }
      if (form.isNew) pool.entries.push(entry)
      else {
        const idx = pool.entries.findIndex((candidate) => candidate.id === form.originalId)
        if (idx >= 0) pool.entries[idx] = entry
      }
      save(state.config)
      state.message = form.isNew ? "entry added" : "entry saved"
      state.form = null
      return
    }
    form.focus++
    return
  }
  if (state.settingsForm) {
    const form = state.settingsForm
    if (form.focus === form.fields.length) {
      const next: PoolConfig = {
        ...state.config,
        port: clampInt(form.port, 1024, 65535) ?? state.config.port,
        cooldown_seconds: clampInt(form.cooldown, 1, 3600) ?? state.config.cooldown_seconds,
        max_failures: clampInt(form.maxFailures, 1, 100) ?? state.config.max_failures,
        rate_limit_cooldown_seconds: clampInt(form.rateCooldown, 1, 3600) ?? state.config.rate_limit_cooldown_seconds,
        auth_fail_cooldown_seconds: clampInt(form.authCooldown, 60, 86400) ?? state.config.auth_fail_cooldown_seconds,
        provider_breaker_trigger: clampInt(form.breakerTrigger, 0, 20) ?? state.config.provider_breaker_trigger,
        provider_breaker_seconds: clampInt(form.breakerSeconds, 10, 86400) ?? state.config.provider_breaker_seconds,
        upstream_timeout_seconds: clampInt(form.timeout, 30, 3600) ?? state.config.upstream_timeout_seconds,
        exhaust_wait_timeout_seconds: clampInt(form.waitBudget, 0, 86400) ?? state.config.exhaust_wait_timeout_seconds,
        max_retry_after_seconds: clampInt(form.maxRetryAfter, 1, 604800) ?? state.config.max_retry_after_seconds ?? 86400,
      }
      const backoff = form.backoff.split(",").map((item) => Number(item.trim())).filter((n) => Number.isFinite(n) && n >= 0)
      if (backoff.length > 0) next.retry_backoff = backoff
      save(next)
      state.config = next
      state.settingsForm = null
      state.message = "settings saved"
      return
    }
    form.focus++
    return
  }
}

function editBackspace(state: State) {
  if (state.form) {
    const field = state.form.fields[state.form.focus]
    if (!field) return
    field.value = field.value.slice(0, field.cursor - 1) + field.value.slice(field.cursor)
    field.cursor = Math.max(0, field.cursor - 1)
    syncForm(state)
    return
  }
  if (state.settingsForm) {
    const form = state.settingsForm
    const field = form.fields[form.focus]
    if (!field) return
    field.value = field.value.slice(0, field.cursor - 1) + field.value.slice(field.cursor)
    field.cursor = Math.max(0, field.cursor - 1)
    syncSettings(form, state)
    return
  }
}

function editClear(state: State) {
  if (state.form) {
    const field = state.form.fields[state.form.focus]
    if (field) {
      field.value = ""
      field.cursor = 0
      syncForm(state)
    }
    return
  }
  if (state.settingsForm) {
    const form = state.settingsForm
    const field = form.fields[form.focus]
    if (field) {
      field.value = ""
      field.cursor = 0
      syncSettings(form, state)
    }
  }
}

function formKey(state: State, key: string) {
  const form = state.form
  if (!form) return
  const field = form.fields[form.focus]
  if (!field) return
  if (field.kind === "cycle") {
    const idx = field.options.indexOf(field.value)
    const next = (idx + 1) % field.options.length
    const option = field.options[next]
    if (option !== undefined) field.value = option
    syncForm(state)
    return
  }
  if (field.kind === "bool") {
    field.value = field.value === "yes" ? "no" : "yes"
    syncForm(state)
    return
  }
  if (key >= " " && key <= "~") {
    field.value = field.value.slice(0, field.cursor) + key + field.value.slice(field.cursor)
    field.cursor++
    syncForm(state)
  }
}

function settingsKey(state: State, key: string) {
  const form = state.settingsForm
  if (!form) return
  const field = form.fields[form.focus]
  if (!field) return
  if (key >= " " && key <= "~") {
    field.value = field.value.slice(0, field.cursor) + key + field.value.slice(field.cursor)
    field.cursor++
    syncSettings(form, state)
  }
}

type FormField = { label: string; value: string; kind: "text" | "cycle" | "bool"; options: string[]; cursor: number; secret: boolean }
type FormState = {
  poolIdx: number
  isNew: boolean
  originalId: string
  preset: string
  entry: { id: string; label: string; adapter: "openai" | "azure" | "anthropic"; base_url: string; model: string; api_key: string; auth: "bearer" | "api-key" | "none"; api_version: string; enabled: boolean; proxy: string; headers: Record<string, string> }
  fields: FormField[]
  focus: number
}
type SettingsForm = {
  port: string
  cooldown: string
  maxFailures: string
  rateCooldown: string
  authCooldown: string
  breakerTrigger: string
  breakerSeconds: string
  timeout: string
  waitBudget: string
  maxRetryAfter: string
  backoff: string
  fields: { label: string; value: string; cursor: number }[]
  focus: number
}
type State = {
  screen: "main" | "settings" | "help"
  poolIdx: number
  entryIdx: number
  health: Health | null
  message: string
  config: PoolConfig
  form: FormState | null
  settingsForm: SettingsForm | null
  helpScroll: number
}

const PRESET_FOR_FORM: Record<string, "openai" | "azure" | "anthropic"> = {
  "opencode-zen": "openai",
  openai: "openai",
  openrouter: "openai",
  deepseek: "openai",
  groq: "openai",
  mistral: "openai",
  xai: "openai",
  google: "openai",
  together: "openai",
  ollama: "openai",
  custom: "openai",
  azure: "azure",
  anthropic: "anthropic",
}

function newEntryIdFor(pool: { entries: { id: string }[] }): string {
  const ids = new Set(pool.entries.map((entry) => entry.id))
  let n = 1
  while (ids.has(`entry-${n}`)) n++
  return `entry-${n}`
}

function openEntryForm(state: State, poolIdx: number, entryIdx: number, isNew: boolean) {
  const pool = state.config.pools[poolIdx]
  if (!pool) return
  const entry = isNew ? null : pool.entries[entryIdx]
  const preset = entry ? presetForEntry(entry) : "opencode-zen"
  state.form = {
    poolIdx,
    isNew,
    originalId: entry?.id ?? "",
    preset,
    entry: entry
      ? { ...entry }
      : { id: "", label: "", adapter: "openai", base_url: "", model: "", api_key: "", auth: "bearer", api_version: "", enabled: true, proxy: "", headers: {} },
    fields: [],
    focus: 0,
  }
  buildFormFields(state.form)
}

function presetForEntry(entry: { adapter: string; base_url: string }): string {
  const candidates: Record<string, string> = {
    "https://opencode.ai/zen/v1": "opencode-zen",
    "https://api.openai.com/v1": "openai",
    "https://api.anthropic.com/v1": "anthropic",
    "https://openrouter.ai/api/v1": "openrouter",
    "https://api.deepseek.com": "deepseek",
    "https://api.groq.com/openai/v1": "groq",
    "https://api.mistral.ai/v1": "mistral",
    "https://api.x.ai/v1": "xai",
    "https://generativelanguage.googleapis.com/v1beta/openai": "google",
    "https://api.together.xyz/v1": "together",
    "http://127.0.0.1:11434/v1": "ollama",
  }
  if (entry.adapter === "anthropic" && entry.base_url === "https://api.anthropic.com/v1") return "anthropic"
  if (entry.adapter === "azure") return "azure"
  return candidates[entry.base_url] ?? "custom"
}

function buildFormFields(form: FormState) {
  const entry = form.entry
  form.fields = [
    { label: "label", value: entry.label, kind: "text", options: [], cursor: entry.label.length, secret: false },
    { label: "preset", value: form.preset, kind: "cycle", options: Object.keys(PRESET_FOR_FORM), cursor: 0, secret: false },
    { label: "base_url", value: entry.base_url, kind: "text", options: [], cursor: entry.base_url.length, secret: false },
    { label: "model", value: entry.model, kind: "text", options: [], cursor: entry.model.length, secret: false },
    { label: "api_key", value: entry.api_key, kind: "text", options: [], cursor: entry.api_key.length, secret: true },
    { label: "auth", value: entry.auth, kind: "cycle", options: ["bearer", "api-key", "none"], cursor: 0, secret: false },
    { label: "api_version", value: entry.api_version, kind: "text", options: [], cursor: entry.api_version.length, secret: false },
    { label: "proxy", value: entry.proxy, kind: "text", options: [], cursor: entry.proxy.length, secret: false },
    { label: "enabled", value: entry.enabled ? "yes" : "no", kind: "bool", options: [], cursor: 0, secret: false },
  ]
}

function syncForm(state: State) {
  const form = state.form
  if (!form) return
  const label = form.fields[0]
  const preset = form.fields[1]
  const baseUrl = form.fields[2]
  const model = form.fields[3]
  const apiKey = form.fields[4]
  const auth = form.fields[5]
  const apiVersion = form.fields[6]
  const proxy = form.fields[7]
  const enabled = form.fields[8]
  if (!label || !preset || !baseUrl || !model || !apiKey || !auth || !apiVersion || !proxy || !enabled) return
  form.entry.label = label.value
  form.preset = preset.value
  form.entry.base_url = baseUrl.value
  form.entry.model = model.value
  form.entry.api_key = apiKey.value
  form.entry.auth = auth.value as "bearer" | "api-key" | "none"
  form.entry.api_version = apiVersion.value
  form.entry.proxy = proxy.value
  form.entry.enabled = enabled.value === "yes"
  form.entry.adapter = PRESET_FOR_FORM[form.preset] ?? "openai"
}

function formNavigate(state: State, dir: "up" | "down" | "left" | "right") {
  const form = state.form
  if (!form) return
  if (dir === "up" || dir === "down") cycleFocus(state, dir)
  else {
    const field = form.fields[form.focus]
    if (!field || field.kind !== "text") return
    field.cursor = dir === "left" ? Math.max(0, field.cursor - 1) : Math.min(field.value.length, field.cursor + 1)
  }
}

function cycleFocus(state: State, dir: "up" | "down") {
  if (state.form) {
    const form = state.form
    const total = form.fields.length + 1
    form.focus = dir === "down" ? (form.focus + 1) % total : (form.focus - 1 + total) % total
    return
  }
  if (state.settingsForm) {
    const form = state.settingsForm
    const total = form.fields.length + 1
    form.focus = dir === "down" ? (form.focus + 1) % total : (form.focus - 1 + total) % total
  }
}

function openSettingsForm(state: State) {
  const cfg = state.config
  state.screen = "settings"
  state.settingsForm = {
    port: String(cfg.port),
    cooldown: String(cfg.cooldown_seconds),
    maxFailures: String(cfg.max_failures),
    rateCooldown: String(cfg.rate_limit_cooldown_seconds),
    authCooldown: String(cfg.auth_fail_cooldown_seconds),
    breakerTrigger: String(cfg.provider_breaker_trigger),
    breakerSeconds: String(cfg.provider_breaker_seconds),
    timeout: String(cfg.upstream_timeout_seconds),
    waitBudget: String(cfg.exhaust_wait_timeout_seconds),
    maxRetryAfter: String(cfg.max_retry_after_seconds ?? 86400),
    backoff: cfg.retry_backoff.join(", "),
    fields: [],
    focus: 0,
  }
  syncSettingsFields(state.settingsForm)
}

function syncSettingsFields(form: SettingsForm) {
  form.fields = [
    { label: "port", value: form.port, cursor: form.port.length },
    { label: "cooldown_seconds", value: form.cooldown, cursor: form.cooldown.length },
    { label: "max_failures", value: form.maxFailures, cursor: form.maxFailures.length },
    { label: "rate_limit_cooldown_seconds", value: form.rateCooldown, cursor: form.rateCooldown.length },
    { label: "auth_fail_cooldown_seconds", value: form.authCooldown, cursor: form.authCooldown.length },
    { label: "provider_breaker_trigger", value: form.breakerTrigger, cursor: form.breakerTrigger.length },
    { label: "provider_breaker_seconds", value: form.breakerSeconds, cursor: form.breakerSeconds.length },
    { label: "upstream_timeout_seconds", value: form.timeout, cursor: form.timeout.length },
    { label: "exhaust_wait_timeout_seconds", value: form.waitBudget, cursor: form.waitBudget.length },
    { label: "max_retry_after_seconds", value: form.maxRetryAfter, cursor: form.maxRetryAfter.length },
    { label: "retry_backoff", value: form.backoff, cursor: form.backoff.length },
  ]
}

function syncSettings(form: SettingsForm, state: State) {
  const values = form.fields.map((field) => field.value)
  form.port = values[0] ?? form.port
  form.cooldown = values[1] ?? form.cooldown
  form.maxFailures = values[2] ?? form.maxFailures
  form.rateCooldown = values[3] ?? form.rateCooldown
  form.authCooldown = values[4] ?? form.authCooldown
  form.breakerTrigger = values[5] ?? form.breakerTrigger
  form.breakerSeconds = values[6] ?? form.breakerSeconds
  form.timeout = values[7] ?? form.timeout
  form.waitBudget = values[8] ?? form.waitBudget
  form.maxRetryAfter = values[9] ?? form.maxRetryAfter
  form.backoff = values[10] ?? form.backoff
  void state
}

function settingsNavigate(state: State, dir: "up" | "down" | "left" | "right") {
  const form = state.settingsForm
  if (!form) return
  if (dir === "up" || dir === "down") cycleFocus(state, dir)
  else {
    const field = form.fields[form.focus]
    if (!field) return
    field.cursor = dir === "left" ? Math.max(0, field.cursor - 1) : Math.min(field.value.length, field.cursor + 1)
  }
}

function clampInt(value: string, min: number, max: number): number | null {
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed)) return null
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function mainKey(state: State, key: string, save: (config: PoolConfig) => void) {
  if (state.screen === "help") {
    state.screen = "main"
    return
  }
  if (key === "n") {
    openEntryForm(state, state.poolIdx, state.entryIdx, true)
    return
  }
  if (key === "N") {
    const id = newPoolIdFor(state.config)
    const label = `Pool ${id}`
    state.config.pools.push({ id, label, entries: [] })
    state.poolIdx = state.config.pools.length - 1
    state.entryIdx = -1
    save(state.config)
    state.message = "pool added; press n to add entries"
    return
  }
  if (key === "d" || key === "D") {
    const pool = state.config.pools[state.poolIdx]
    if (!pool) return
    if (state.entryIdx >= 0) {
      pool.entries.splice(state.entryIdx, 1)
      state.entryIdx = Math.min(state.entryIdx, pool.entries.length - 1)
      save(state.config)
      state.message = "entry deleted"
    } else {
      state.config.pools.splice(state.poolIdx, 1)
      state.poolIdx = Math.min(state.poolIdx, state.config.pools.length - 1)
      state.entryIdx = -1
      save(state.config)
      state.message = "pool deleted"
    }
    return
  }
  if (key === "x") {
    const pool = state.config.pools[state.poolIdx]
    if (!pool || state.entryIdx < 0) return
    const entry = pool.entries[state.entryIdx]
    if (!entry) return
    entry.enabled = !entry.enabled
    save(state.config)
    state.message = entry.enabled ? "entry enabled" : "entry disabled"
    return
  }
  if (key === "e") {
    const pool = state.config.pools[state.poolIdx]
    if (!pool) return
    if (state.entryIdx >= 0) openEntryForm(state, state.poolIdx, state.entryIdx, false)
    return
  }
  if (key === "R") {
    state.health = null
    state.message = "health cache cleared"
    return
  }
  if (key === "s") {
    openSettingsForm(state)
    return
  }
  if (key === "?") {
    state.screen = "help"
    state.helpScroll = 0
  }
}

function newPoolIdFor(config: PoolConfig): string {
  const ids = new Set(config.pools.map((pool) => pool.id))
  let n = 1
  while (ids.has(`pool-${n}`)) n++
  return `pool-${n}`
}

function entryDot(state: State, poolId: string, entryId: string, enabled: boolean): string {
  if (!enabled) return `${DIM}·${RESET}`
  const status = state.health?.entries?.find((entry) => entry.id === entryId && entry.pool === poolId)
  if (!status) return `${DIM}?${RESET}`
  if (status.cooldown > 0) return `${YELLOW}○${RESET}`
  if (status.last_error) return `${RED}!${RESET}`
  return `${GREEN}●${RESET}`
}

function visibleListHeight(state: State, rows: number): number {
  const overhead = state.screen === "main" ? 7 : 7
  return Math.max(5, rows - overhead)
}

function renderScreen(state: State, cols: number, rows: number): string {
  const lines: string[] = []
  const title = `${BOLD}oc-route${RESET} ${DIM}IP rotation and never-stop failover${RESET}`
  lines.push(pad(title, cols))
  const daemon = daemonLine(state)
  lines.push(pad(daemon, cols))
  lines.push(pad(`${DIM}─`.repeat(Math.max(0, cols)) + RESET, cols))
  if (state.form) {
    renderForm(state, lines, cols, rows)
    return lines.join("")
  }
  if (state.settingsForm) {
    renderSettings(state, lines, cols, rows)
    return lines.join("")
  }
  if (state.screen === "help") {
    renderHelp(state, lines, cols, rows)
    return lines.join("")
  }
  renderMain(state, lines, cols, rows)
  return lines.join("")
}

function pad(text: string, cols: number): string {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "")
  const padLen = Math.max(0, cols - stripped.length)
  return text + " ".repeat(padLen)
}

function daemonLine(state: State): string {
  const port = state.config.port
  if (!state.health) return `${RED}daemon: down${RESET}  run "oc-route start" or open opencode to auto-start it`
  const breaker = state.health.breaker
  let breakerText = ""
  if (breaker?.active) breakerText = `  ${RED}circuit breaker: ${breaker.remaining}s${RESET}`
  const stats = state.health.stats
  let statsText = ""
  if (stats) statsText = `  requests ${stats.requests} · failovers ${stats.failovers} · rate limits ${stats.rate_limits} · auth fails ${stats.auth_failures}`
  return `${GREEN}daemon: up${RESET} (127.0.0.1:${port})${breakerText}${statsText}`
}

function renderMain(state: State, lines: string[], cols: number, rows: number) {
  if (state.config.pools.length === 0) {
    lines.push(pad("", cols))
    lines.push(pad(`No pools yet. Press ${BOLD}n${RESET} to create the first pool, then add entries to it.`, cols))
    lines.push(pad("", cols))
    lines.push(pad("Each entry is one (provider, model, API key) combination. Keys rotate on failure,", cols))
    lines.push(pad("then fall back to other models and providers in list order.", cols))
    lines.push(pad("", cols))
  } else {
    const maxHeight = visibleListHeight(state, rows)
    let start = 0
    const items = flatten(state.config)
    const current = items.findIndex((item) => "entry" in item && item.pool === state.poolIdx && item.entry === state.entryIdx)
    if (current >= maxHeight) start = current - maxHeight + 1
    const visible = items.slice(start, start + maxHeight)
    for (const item of visible) {
      if ("entry" in item) {
        const pool = state.config.pools[item.pool]
        if (!pool) continue
        const entry = pool.entries[item.entry]
        if (!entry) continue
        const selected = item.pool === state.poolIdx && item.entry === state.entryIdx
        const dot = entryDot(state, pool.id, entry.id, entry.enabled)
        const marker = `${dot} [${entry.enabled ? "x" : " "}]`
        const label = `  ${entry.label || entry.model}  ${DIM}${entry.model}${RESET}`
        const cooldown = statusCooldown(state, pool.id, entry.id)
        const prefix = selected ? REVERSE : ""
        const suffix = selected ? RESET : ""
        lines.push(pad(`${prefix}${marker} ${label}${cooldown}${suffix}`, cols))
      } else {
        const pool = state.config.pools[item.pool]
        if (!pool) continue
        const selected = item.pool === state.poolIdx && state.entryIdx < 0
        const prefix = selected ? REVERSE : ""
        const suffix = selected ? RESET : ""
        lines.push(pad(`${prefix}${BOLD}${pool.label}${RESET}${suffix}  ${DIM}(${pool.id}, ${pool.entries.length} entries)${RESET}`, cols))
      }
    }
  }
  lines.push(pad(`${DIM}─`.repeat(Math.max(0, cols)) + RESET, cols))
  const hint = [
    "↑↓ move",
    "Enter edit",
    "n new entry",
    "N new pool",
    "d delete",
    "x toggle",
    "e edit",
    "Ctrl↑↓ reorder",
    "s settings",
    "? help",
    "q quit",
  ].join(" · ")
  lines.push(pad(`${DIM}${hint}${RESET}`, cols))
  if (state.message) lines.push(pad(`${CYAN}${state.message}${RESET}`, cols))
}

function statusCooldown(state: State, poolId: string, entryId: string): string {
  const status = state.health?.entries?.find((entry) => entry.id === entryId && entry.pool === poolId)
  if (!status || status.cooldown <= 0) return ""
  return `  ${YELLOW}cool ${status.cooldown}s${RESET}`
}

function renderForm(state: State, lines: string[], cols: number, rows: number) {
  const form = state.form!
  const pool = state.config.pools[form.poolIdx]
  lines.push(pad(`${BOLD}${form.isNew ? "New entry" : "Edit entry"}${RESET} — pool ${pool?.label ?? "?"} (${pool?.id ?? "?"})`, cols))
  lines.push(pad("", cols))
  const maxHeight = Math.max(4, rows - 6)
  const start = Math.max(0, form.focus - maxHeight + 1)
  const visible = form.fields.slice(start, start + maxHeight)
  for (const field of visible) {
    const focused = form.fields[form.focus] === field
    const display = field.secret ? maskSecret(field.value) : field.value
    const cursor = focused ? `${REVERSE} ${RESET}` : ""
    const prefix = focused ? REVERSE : ""
    const suffix = focused ? RESET : ""
    lines.push(pad(`${prefix}  ${field.label.padEnd(14)}: ${display}${cursor}${suffix}`, cols))
  }
  const saveRow = form.focus === form.fields.length ? REVERSE : ""
  lines.push(pad(`${saveRow}  [Save]${RESET}${form.focus === form.fields.length ? "" : `  ${DIM}Tab to reach Save, Enter to confirm${RESET}`}`, cols))
  lines.push(pad(`${DIM}Type to edit · ←→ move cursor · Backspace delete · Ctrl+U clear · ↑↓ change field · Enter confirm · Esc cancel · q quit${RESET}`, cols))
}

function maskSecret(value: string): string {
  if (!value) return ""
  if (value.length <= 8) return "*".repeat(value.length)
  return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`
}

function renderSettings(state: State, lines: string[], cols: number, rows: number) {
  const form = state.settingsForm!
  lines.push(pad(`${BOLD}Global settings${RESET}`, cols))
  lines.push(pad("", cols))
  const maxHeight = Math.max(4, rows - 6)
  const start = Math.max(0, form.focus - maxHeight + 1)
  const visible = form.fields.slice(start, start + maxHeight)
  for (const field of visible) {
    const focused = form.fields[form.focus] === field
    const prefix = focused ? REVERSE : ""
    const suffix = focused ? RESET : ""
    lines.push(pad(`${prefix}  ${field.label.padEnd(32)}: ${field.value}${suffix}`, cols))
  }
  lines.push(pad(`${form.focus === form.fields.length ? REVERSE : ""}  [Save]${RESET}`, cols))
  lines.push(pad(`${DIM}Note: port changes need a daemon restart ("oc-route restart")${RESET}`, cols))
}

function renderHelp(state: State, lines: string[], cols: number, rows: number) {
  void state
  const help = [
    "How it works",
    "",
    "opencode talks to the route daemon (an OpenAI-compatible endpoint on 127.0.0.1).",
    "Each pool is exposed as a model named after the pool id, e.g. route/default.",
    "Every request is routed to one entry: a specific (provider, model, API key).",
    "",
    "Failover order:",
    "  1. A session sticks to its current entry while it keeps working.",
    "  2. Auth errors (401/403) cool the entry down and the request retries the next.",
    "  3. Rate limits (429) cool the entry down until the upstream retry-after (for",
    "     Zen free models that is the next UTC midnight) and the request retries.",
    "  4. Server errors (5xx) and network failures count against the entry; after",
    "     max_failures it cools down and the request moves on.",
    "  5. When every entry is cooling down the request holds until the earliest",
    "     reset and resumes on its own (never-stop; set exhaust_wait_timeout_seconds",
    "     to bound the wait).",
    "",
    "Entries are tried in list order; each entry is a (provider, model, key, proxy)",
    "combination. On Zen free models the limit is per IP, so give each entry its",
    "own egress proxy/VPN to get its own quota.",
    "",
    "Keys",
    "  n        new entry          N        new pool",
    "  e        edit entry         x        toggle entry on/off",
    "  d        delete             Ctrl+Up/Down  reorder entry",
    "  s        global settings    ?        this help",
    "  q        quit (saves automatically)",
  ]
  const maxHeight = Math.max(4, rows - 4)
  const start = Math.min(state.helpScroll, Math.max(0, help.length - maxHeight))
  for (const line of help.slice(start, start + maxHeight)) {
    lines.push(pad(line, cols))
  }
  lines.push(pad(`${DIM}press any key to go back${RESET}`, cols))
}
