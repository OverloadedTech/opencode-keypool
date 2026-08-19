import { describe, expect, test } from "bun:test"
import { PoolEngine } from "../src/engine.ts"
import type { PoolConfig } from "../src/config.ts"

function makeConfig(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    port: 4777,
    cooldown_seconds: 1,
    max_failures: 3,
    rate_limit_cooldown_seconds: 1,
    auth_fail_cooldown_seconds: 1,
    provider_breaker_trigger: 2,
    provider_breaker_seconds: 5,
    retry_backoff: [0.05, 0.1],
    upstream_timeout_seconds: 5,
    exhaust_wait_timeout_seconds: 60,
    pools: [
      {
        id: "main",
        label: "Main",
        entries: [
          { id: "a", label: "A", adapter: "openai", base_url: "http://a", model: "m1", api_key: "k1", auth: "bearer", api_version: "", enabled: true, proxy: "", headers: {} },
          { id: "b", label: "B", adapter: "openai", base_url: "http://b", model: "m2", api_key: "k2", auth: "bearer", api_version: "", enabled: true, proxy: "", headers: {} },
          { id: "c", label: "C", adapter: "anthropic", base_url: "http://c", model: "m3", api_key: "k3", auth: "bearer", api_version: "", enabled: false, proxy: "", headers: {} },
        ],
      },
    ],
    ...overrides,
  }
}

describe("PoolEngine", () => {
  test("picks the first enabled entry in order", () => {
    const engine = new PoolEngine(makeConfig())
    expect(engine.pick("main", null)?.id).toBe("a")
    expect(engine.pick("main", null, new Set(["a"]))?.id).toBe("b")
  })

  test("sessions stick to their entry", () => {
    const engine = new PoolEngine(makeConfig())
    engine.rememberSession("s1", "b")
    expect(engine.pick("main", "s1")?.id).toBe("b")
    expect(engine.pick("main", "s2")?.id).toBe("a")
  })

  test("cooldown after max failures", () => {
    const engine = new PoolEngine(makeConfig({ max_failures: 2 }))
    engine.onFailure("a", "boom")
    expect(engine.pick("main", null)?.id).toBe("a")
    engine.onFailure("a", "boom")
    expect(engine.pick("main", null)?.id).toBe("b")
    expect(engine.entryStatus("a")?.cooldown).toBeGreaterThan(0)
  })

  test("auth failure cools the entry immediately", () => {
    const engine = new PoolEngine(makeConfig())
    engine.onAuthFailure("a", "401")
    expect(engine.pick("main", null)?.id).toBe("b")
  })

  test("rate limit cools the entry and failover happens", () => {
    const engine = new PoolEngine(makeConfig())
    engine.onRateLimit("a", "429 too many requests")
    expect(engine.pick("main", null)?.id).toBe("b")
    expect(engine.entryStatus("a")?.cooldown).toBeGreaterThan(0)
  })

  test("circuit breaker arms after distinct entries are rate limited", () => {
    const engine = new PoolEngine(makeConfig())
    engine.onRateLimit("a", "429")
    engine.onRateLimit("b", "429")
    expect(engine.breaker().active).toBe(true)
    expect(engine.pick("main", null)).toBeNull()
  })

  test("breaker stays off when trigger is 0 or negative", () => {
    const engine = new PoolEngine(makeConfig({ provider_breaker_trigger: 0 }))
    engine.onRateLimit("a", "429")
    engine.onRateLimit("b", "429")
    expect(engine.breaker().active).toBe(false)
  })

  test("exhaustionWaitSeconds reports the earliest cooldown expiry", () => {
    const engine = new PoolEngine(makeConfig({ rate_limit_cooldown_seconds: 30, provider_breaker_trigger: 0 }))
    engine.onRateLimit("a", "429")
    engine.onRateLimit("b", "429")
    const wait = engine.exhaustionWaitSeconds("main")
    expect(wait).toBeGreaterThan(15)
    expect(wait).toBeLessThanOrEqual(30)
  })

  test("rate limit honors upstream retry-after", () => {
    const engine = new PoolEngine(makeConfig({ provider_breaker_trigger: 0 }))
    engine.onRateLimit("a", "429", null, 120)
    const cooldown = engine.entryStatus("a")?.cooldown ?? 0
    expect(cooldown).toBeGreaterThan(118)
    expect(cooldown).toBeLessThanOrEqual(120)
  })

  test("rate limit falls back to configured cooldown without retry-after", () => {
    const engine = new PoolEngine(makeConfig({ rate_limit_cooldown_seconds: 7, provider_breaker_trigger: 0 }))
    engine.onRateLimit("a", "429")
    const cooldown = engine.entryStatus("a")?.cooldown ?? 0
    expect(cooldown).toBeGreaterThan(6)
    expect(cooldown).toBeLessThanOrEqual(7)
  })

  test("rate limit retry-after is capped by max_retry_after_seconds", () => {
    const engine = new PoolEngine(makeConfig({ provider_breaker_trigger: 0, max_retry_after_seconds: 10 }))
    engine.onRateLimit("a", "429", null, 9999)
    const cooldown = engine.entryStatus("a")?.cooldown ?? 0
    expect(cooldown).toBeGreaterThan(9)
    expect(cooldown).toBeLessThanOrEqual(10)
  })

  test("success resets failure counters", () => {
    const engine = new PoolEngine(makeConfig({ max_failures: 3 }))
    engine.onFailure("a", "boom")
    engine.onFailure("a", "boom")
    engine.onSuccess("a")
    engine.onFailure("a", "boom")
    engine.onFailure("a", "boom")
    expect(engine.pick("main", null)?.id).toBe("a")
  })

  test("disabled entries are never picked", () => {
    const engine = new PoolEngine(makeConfig())
    engine.onAuthFailure("a", "401")
    engine.onAuthFailure("b", "401")
    expect(engine.pick("main", null)).toBeNull()
  })

  test("reload drops state for removed entries", () => {
    const engine = new PoolEngine(makeConfig())
    engine.onAuthFailure("a", "401")
    const next = makeConfig()
    const pool = next.pools[0]
    if (pool) pool.entries = pool.entries.filter((entry) => entry.id !== "a")
    engine.reload(next)
    expect(engine.status().map((entry) => entry.id)).toEqual(["b", "c"])
  })
})
