import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type EntryAuth = "bearer" | "api-key" | "none"

export type Entry = {
  id: string
  label: string
  adapter: "openai" | "azure" | "anthropic"
  base_url: string
  model: string
  api_key: string
  auth: EntryAuth
  api_version: string
  enabled: boolean
  proxy: string
  headers: Record<string, string>
}

export type Pool = {
  id: string
  label: string
  entries: Entry[]
}

export type PoolConfig = {
  port: number
  cooldown_seconds: number
  max_failures: number
  rate_limit_cooldown_seconds: number
  auth_fail_cooldown_seconds: number
  provider_breaker_trigger: number
  provider_breaker_seconds: number
  retry_backoff: number[]
  upstream_timeout_seconds: number
  exhaust_wait_timeout_seconds: number
  max_retry_after_seconds?: number
  pools: Pool[]
}

export type ProviderPreset = {
  name: string
  adapter: Entry["adapter"]
  base_url: string
  auth: EntryAuth
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  "opencode-zen": { name: "OpenCode Zen", adapter: "openai", base_url: "https://opencode.ai/zen/v1", auth: "bearer" },
  openai: { name: "OpenAI", adapter: "openai", base_url: "https://api.openai.com/v1", auth: "bearer" },
  anthropic: { name: "Anthropic", adapter: "anthropic", base_url: "https://api.anthropic.com/v1", auth: "bearer" },
  azure: { name: "Azure OpenAI", adapter: "azure", base_url: "", auth: "api-key" },
  openrouter: { name: "OpenRouter", adapter: "openai", base_url: "https://openrouter.ai/api/v1", auth: "bearer" },
  deepseek: { name: "DeepSeek", adapter: "openai", base_url: "https://api.deepseek.com", auth: "bearer" },
  groq: { name: "Groq", adapter: "openai", base_url: "https://api.groq.com/openai/v1", auth: "bearer" },
  mistral: { name: "Mistral", adapter: "openai", base_url: "https://api.mistral.ai/v1", auth: "bearer" },
  xai: { name: "xAI", adapter: "openai", base_url: "https://api.x.ai/v1", auth: "bearer" },
  google: { name: "Google (OpenAI-compat)", adapter: "openai", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", auth: "bearer" },
  together: { name: "Together", adapter: "openai", base_url: "https://api.together.xyz/v1", auth: "bearer" },
  ollama: { name: "Ollama", adapter: "openai", base_url: "http://127.0.0.1:11434/v1", auth: "none" },
  custom: { name: "Custom (OpenAI-compatible)", adapter: "openai", base_url: "", auth: "bearer" },
}

export const DEFAULT_CONFIG: PoolConfig = {
  port: 4777,
  cooldown_seconds: 60,
  max_failures: 5,
  rate_limit_cooldown_seconds: 60,
  auth_fail_cooldown_seconds: 1800,
  provider_breaker_trigger: 0,
  provider_breaker_seconds: 900,
  retry_backoff: [0.4, 0.8, 1.5, 3.0],
  upstream_timeout_seconds: 600,
  exhaust_wait_timeout_seconds: 0,
  max_retry_after_seconds: 86400,
  pools: [],
}

export function xdgHome(): string {
  if (process.platform === "win32") return process.env.APPDATA || join(process.env.USERPROFILE || ".", "AppData", "Roaming")
  return process.env.XDG_CONFIG_HOME || join(process.env.HOME || "/", ".config")
}

export function stateHome(): string {
  if (process.platform === "win32") return process.env.LOCALAPPDATA || join(process.env.USERPROFILE || ".", "AppData", "Local")
  return process.env.XDG_STATE_HOME || join(process.env.HOME || "/", ".local", "state")
}

export const CONFIG_DIR = join(xdgHome(), "opencode-route")
export const CONFIG_PATH = join(CONFIG_DIR, "config.json")
export const STATE_DIR = join(stateHome(), "opencode-route")
export const PID_PATH = join(STATE_DIR, "route.pid")
export const LOG_PATH = join(STATE_DIR, "route.log")

export function ensureDirs(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function sanitizeEntry(raw: unknown, fallbackId: number): Entry | null {
  if (!isPlainObject(raw)) return null
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback)
  const adapter = raw.adapter === "azure" || raw.adapter === "anthropic" ? raw.adapter : "openai"
  const auth = raw.auth === "api-key" || raw.auth === "none" ? raw.auth : "bearer"
  const id = str(raw.id) || `entry-${fallbackId}`
  if (!str(raw.model)) return null
  const headers: Record<string, string> = {}
  if (isPlainObject(raw.headers)) {
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof value === "string") headers[key] = value
    }
  }
  return {
    id,
    label: str(raw.label) || str(raw.model),
    adapter,
    base_url: str(raw.base_url),
    model: str(raw.model),
    api_key: str(raw.api_key),
    auth,
    api_version: str(raw.api_version),
    enabled: raw.enabled !== false,
    proxy: str(raw.proxy),
    headers,
  }
}

function sanitizePool(raw: unknown, fallbackId: number): Pool | null {
  if (!isPlainObject(raw)) return null
  const id = (typeof raw.id === "string" && raw.id) || `pool-${fallbackId}`
  if (!Array.isArray(raw.entries)) return null
  const entries = raw.entries
    .map((entry, index) => sanitizeEntry(entry, index + 1))
    .filter((entry): entry is Entry => entry !== null)
  return { id, label: typeof raw.label === "string" && raw.label ? raw.label : id, entries }
}

function sanitizeConfig(raw: unknown): PoolConfig {
  if (!isPlainObject(raw)) return structuredClone(DEFAULT_CONFIG)
  const num = (v: unknown, fallback: number): number => (isNumber(v) ? Math.floor(v) : fallback)
  const retry = Array.isArray(raw.retry_backoff) ? raw.retry_backoff.filter(isNumber) : []
  const pools = Array.isArray(raw.pools)
    ? raw.pools.map((pool, index) => sanitizePool(pool, index + 1)).filter((pool): pool is Pool => pool !== null)
    : []
  return {
    port: num(raw.port, DEFAULT_CONFIG.port),
    cooldown_seconds: num(raw.cooldown_seconds, DEFAULT_CONFIG.cooldown_seconds),
    max_failures: num(raw.max_failures, DEFAULT_CONFIG.max_failures),
    rate_limit_cooldown_seconds: num(raw.rate_limit_cooldown_seconds, DEFAULT_CONFIG.rate_limit_cooldown_seconds),
    auth_fail_cooldown_seconds: num(raw.auth_fail_cooldown_seconds, DEFAULT_CONFIG.auth_fail_cooldown_seconds),
    provider_breaker_trigger: num(raw.provider_breaker_trigger, DEFAULT_CONFIG.provider_breaker_trigger),
    provider_breaker_seconds: num(raw.provider_breaker_seconds, DEFAULT_CONFIG.provider_breaker_seconds),
    retry_backoff: retry.length > 0 ? retry : DEFAULT_CONFIG.retry_backoff,
    upstream_timeout_seconds: num(raw.upstream_timeout_seconds, DEFAULT_CONFIG.upstream_timeout_seconds),
    exhaust_wait_timeout_seconds: num(raw.exhaust_wait_timeout_seconds, DEFAULT_CONFIG.exhaust_wait_timeout_seconds),
    max_retry_after_seconds: num(raw.max_retry_after_seconds, DEFAULT_CONFIG.max_retry_after_seconds ?? 86400),
    pools,
  }
}

export function loadConfig(path: string = CONFIG_PATH): PoolConfig {
  ensureDirs()
  if (!existsSync(path)) {
    const config = structuredClone(DEFAULT_CONFIG)
    saveConfig(config, path)
    return config
  }
  try {
    return sanitizeConfig(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    const config = structuredClone(DEFAULT_CONFIG)
    saveConfig(config, path)
    return config
  }
}

export function saveConfig(config: PoolConfig, path: string = CONFIG_PATH): void {
  ensureDirs()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, path)
}

export function configMtime(path: string = CONFIG_PATH): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

export function newEntryId(pool: Pool): string {
  const ids = new Set(pool.entries.map((entry) => entry.id))
  let n = 1
  while (ids.has(`entry-${n}`)) n++
  return `entry-${n}`
}

export function newPoolId(config: PoolConfig): string {
  const ids = new Set(config.pools.map((pool) => pool.id))
  let n = 1
  while (ids.has(`pool-${n}`)) n++
  return `pool-${n}`
}

export function validatePoolId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(id)
}

export function findPool(config: PoolConfig, model: string): Pool | undefined {
  return config.pools.find((pool) => pool.id === model)
}

export function redactProxy(proxy: string): string {
  const match = /^([a-z0-9]+:\/\/)([^@/]+)@(.*)$/i.exec(proxy)
  if (!match) return proxy
  const user = match[2] ?? ""
  const userPart = user.split(":")[0] ?? ""
  return `${match[1]}${userPart}:***@${match[3]}`
}

export function redactConfig(config: PoolConfig): PoolConfig {
  const clone = structuredClone(config)
  for (const pool of clone.pools) {
    for (const entry of pool.entries) {
      if (entry.api_key.length > 8) entry.api_key = `${entry.api_key.slice(0, 4)}...${entry.api_key.slice(-4)}`
      else if (entry.api_key) entry.api_key = "****"
      if (entry.proxy) entry.proxy = redactProxy(entry.proxy)
      for (const key of Object.keys(entry.headers)) {
        if (/auth|key|token/i.test(key)) entry.headers[key] = "****"
      }
    }
  }
  return clone
}

export function configDir(): string {
  return dirname(CONFIG_PATH)
}
