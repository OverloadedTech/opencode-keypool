import type { Entry, Pool, PoolConfig } from "./config.ts"

export type EntryStatus = {
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

export type ProviderBreaker = {
  active: boolean
  remaining: number
  reason: string
}

export type EngineStats = {
  requests: number
  failovers: number
  auth_failures: number
  rate_limits: number
  upstream_errors: number
  waits: number
}

const MAX_SESSION_MEMORY = 10_000

export class PoolEngine {
  private config: PoolConfig
  private fails = new Map<string, number>()
  private cooldownUntil = new Map<string, number>()
  private sessions = new Map<string, string>()
  private breakerUntil = 0
  private breakerReason = ""
  private recentRateLimits: { id: string; at: number }[] = []
  private lastError = new Map<string, string>()
  private lastUsed = new Map<string, number>()
  private successes = new Map<string, number>()
  stats: EngineStats = { requests: 0, failovers: 0, auth_failures: 0, rate_limits: 0, upstream_errors: 0, waits: 0 }

  constructor(config: PoolConfig) {
    this.config = config
  }

  reload(config: PoolConfig): void {
    this.config = config
    for (const key of this.fails.keys()) {
      if (!this.findEntry(key)) {
        this.fails.delete(key)
        this.cooldownUntil.delete(key)
        this.lastError.delete(key)
        this.lastUsed.delete(key)
        this.successes.delete(key)
      }
    }
  }

  get pools(): Pool[] {
    return this.config.pools
  }

  private findEntry(entryId: string): Entry | undefined {
    for (const pool of this.config.pools) {
      const entry = pool.entries.find((candidate) => candidate.id === entryId)
      if (entry) return entry
    }
    return undefined
  }

  private entryPool(entryId: string): Pool | undefined {
    return this.config.pools.find((pool) => pool.entries.some((entry) => entry.id === entryId))
  }

  private usableEntries(pool: Pool, now: number): Entry[] {
    return pool.entries.filter((entry) => {
      if (!entry.enabled) return false
      if (this.breakerUntil > now) return false
      const cooldown = this.cooldownUntil.get(entry.id) ?? 0
      return cooldown <= now
    })
  }

  pick(poolId: string, sessionId: string | null, skip: Set<string> = new Set()): Entry | null {
    const pool = this.config.pools.find((candidate) => candidate.id === poolId)
    if (!pool) return null
    const now = Date.now()
    if (this.breakerUntil > now) return null
    const usable = this.usableEntries(pool, now).filter((entry) => !skip.has(entry.id))
    if (usable.length === 0) return null
    if (sessionId) {
      const stickyId = this.sessions.get(sessionId)
      if (stickyId && !skip.has(stickyId)) {
        const sticky = usable.find((entry) => entry.id === stickyId)
        if (sticky) return sticky
        this.sessions.delete(sessionId)
      }
    }
    return usable[0] ?? null
  }

  breaker(): ProviderBreaker {
    const remaining = Math.max(0, Math.ceil((this.breakerUntil - Date.now()) / 1000))
    return { active: remaining > 0, remaining, reason: this.breakerReason }
  }

  exhaustionWaitSeconds(poolId: string): number {
    const pool = this.config.pools.find((candidate) => candidate.id === poolId)
    if (!pool) return 0
    const now = Date.now()
    let earliest = Infinity
    for (const entry of pool.entries) {
      if (!entry.enabled) continue
      const until = this.cooldownUntil.get(entry.id) ?? 0
      if (until > now) earliest = Math.min(earliest, until)
    }
    if (this.breakerUntil > now) earliest = Math.min(earliest, this.breakerUntil)
    if (earliest === Infinity) return 0
    return Math.max(1, Math.ceil((earliest - now) / 1000))
  }

  recordWait(): void {
    this.stats.waits++
  }

  onSuccess(entryId: string): void {
    this.fails.set(entryId, 0)
    this.lastError.delete(entryId)
    this.lastUsed.set(entryId, Date.now())
    this.successes.set(entryId, (this.successes.get(entryId) ?? 0) + 1)
  }

  onFailure(entryId: string, error: string, sessionId: string | null = null): void {
    if (sessionId) this.sessions.delete(sessionId)
    const fails = (this.fails.get(entryId) ?? 0) + 1
    this.fails.set(entryId, fails)
    this.lastError.set(entryId, error.slice(0, 200))
    this.lastUsed.set(entryId, Date.now())
    if (fails >= this.config.max_failures) {
      this.cooldownUntil.set(entryId, Date.now() + this.config.cooldown_seconds * 1000)
      this.fails.set(entryId, 0)
    }
  }

  onAuthFailure(entryId: string, error: string, sessionId: string | null = null): void {
    if (sessionId) this.sessions.delete(sessionId)
    this.cooldownUntil.set(entryId, Date.now() + this.config.auth_fail_cooldown_seconds * 1000)
    this.fails.set(entryId, 0)
    this.lastError.set(entryId, error.slice(0, 200))
    this.lastUsed.set(entryId, Date.now())
    this.stats.auth_failures++
  }

  onRateLimit(entryId: string, reason: string, sessionId: string | null = null): void {
    if (sessionId) this.sessions.delete(sessionId)
    const now = Date.now()
    this.cooldownUntil.set(
      entryId,
      Math.max(this.cooldownUntil.get(entryId) ?? 0, now + this.config.rate_limit_cooldown_seconds * 1000),
    )
    this.fails.set(entryId, 0)
    this.lastError.set(entryId, reason.slice(0, 200))
    this.lastUsed.set(entryId, now)
    this.stats.rate_limits++
    if (this.config.provider_breaker_trigger <= 0) return
    this.recentRateLimits = this.recentRateLimits.filter((item) => now - item.at < 10 * 60 * 1000)
    if (!this.recentRateLimits.some((item) => item.id === entryId)) {
      this.recentRateLimits.push({ id: entryId, at: now })
    }
    if (this.recentRateLimits.length >= this.config.provider_breaker_trigger) {
      this.armBreaker(reason)
    }
  }

  onUpstreamError(entryId: string, error: string, sessionId: string | null = null): void {
    this.stats.upstream_errors++
    this.onFailure(entryId, error, sessionId)
  }

  recordFailover(): void {
    this.stats.failovers++
  }

  recordRequest(): void {
    this.stats.requests++
  }

  armBreaker(reason: string): void {
    const now = Date.now()
    this.breakerUntil = Math.max(this.breakerUntil, now + this.config.provider_breaker_seconds * 1000)
    this.breakerReason = reason.slice(0, 160)
    this.recentRateLimits = []
  }

  clearBreaker(): void {
    this.breakerUntil = 0
    this.breakerReason = ""
  }

  entryStatus(entryId: string): EntryStatus | null {
    const entry = this.findEntry(entryId)
    if (!entry) return null
    const pool = this.entryPool(entryId)
    if (!pool) return null
    const cooldown = Math.max(0, Math.ceil(((this.cooldownUntil.get(entryId) ?? 0) - Date.now()) / 1000))
    return {
      id: entry.id,
      pool: pool.id,
      label: entry.label,
      model: entry.model,
      adapter: entry.adapter,
      enabled: entry.enabled,
      cooldown,
      failures: this.fails.get(entryId) ?? 0,
      last_error: this.lastError.get(entryId) ?? "",
      last_used_at: this.lastUsed.get(entryId) ?? 0,
      successes: this.successes.get(entryId) ?? 0,
    }
  }

  status(): EntryStatus[] {
    const out: EntryStatus[] = []
    for (const pool of this.config.pools) {
      for (const entry of pool.entries) {
        const status = this.entryStatus(entry.id)
        if (status) out.push(status)
      }
    }
    return out
  }

  rememberSession(sessionId: string, entryId: string): void {
    this.sessions.set(sessionId, entryId)
    if (this.sessions.size > MAX_SESSION_MEMORY) {
      const oldest = this.sessions.keys().next().value
      if (oldest !== undefined) this.sessions.delete(oldest)
    }
  }
}

export function backoffDelay(backoff: number[], attempt: number): number {
  return backoff[Math.min(attempt, backoff.length - 1)] ?? 0
}
