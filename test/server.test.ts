import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve, type KeypoolServer } from "../src/server.ts"

type Mock = {
  url: string
  hits: string[]
  stop(): Promise<void>
}

function mockUpstream(handler: (request: Request, hits: string[]) => Response): Mock {
  const hits: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      hits.push(request.headers.get("Authorization") ?? request.headers.get("x-api-key") ?? "")
      return handler(request, hits)
    },
  })
  return { url: server.url.toString().replace(/\/$/, ""), hits, stop: async () => server.stop(true) }
}

function chatJson(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "m1",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

type TestEnv = {
  server: KeypoolServer
  configPath: string
  dir: string
  mocks: Mock[]
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function writePoolConfig(entries: Record<string, unknown>[], overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "keypool-test-"))
  const configPath = join(dir, "config.json")
  writeFileSync(
    configPath,
    JSON.stringify({
      port: 0,
      cooldown_seconds: 1,
      max_failures: 2,
      rate_limit_cooldown_seconds: 2,
      auth_fail_cooldown_seconds: 2,
      provider_breaker_trigger: 2,
      provider_breaker_seconds: 10,
      retry_backoff: [0.02],
      upstream_timeout_seconds: 10,
      pools: [{ id: "main", label: "Main", entries }],
      ...overrides,
    }),
  )
  return configPath
}

function baseEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "e",
    label: "e",
    adapter: "openai",
    base_url: "",
    model: "m",
    api_key: "k",
    auth: "bearer",
    api_version: "",
    enabled: true,
    proxy: "",
    headers: {},
    ...overrides,
  }
}

async function startServer(configPath: string): Promise<TestEnv> {
  const server = serve(configPath)
  cleanups.push(async () => {
    await server.stop()
    rmSync(dirOf(configPath), { recursive: true, force: true })
  })
  return { server, configPath, dir: dirOf(configPath), mocks: [] }
}

function dirOf(configPath: string): string {
  return join(configPath, "..")
}

async function post(server: KeypoolServer, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${server.url.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonOf(response: Response): Promise<any> {
  return response.json()
}

describe("keypool server", () => {
  test("fails over to the next key on 401", async () => {
    const bad = mockUpstream((request) => {
      if (request.headers.get("Authorization") === "Bearer k1") {
        return new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 })
      }
      return new Response(chatJson("hi from key 2"), { status: 200 })
    })
    const env = await startServer(
      writePoolConfig([
        baseEntry({ id: "e1", base_url: bad.url, api_key: "k1" }),
        baseEntry({ id: "e2", base_url: bad.url, api_key: "k2" }),
      ]),
    )
    env.mocks.push(bad)
    const response = await post(env.server, { model: "main", messages: [{ role: "user", content: "hi" }] })
    expect(response.status).toBe(200)
    const parsed = await jsonOf(response)
    expect(parsed.choices[0].message.content).toBe("hi from key 2")
    expect(bad.hits).toContain("Bearer k1")
    expect(bad.hits).toContain("Bearer k2")
  })

  test("fails over from an OpenAI provider to an Anthropic provider", async () => {
    const broken = mockUpstream(() => new Response("upstream exploded", { status: 500 }))
    const anthropic = mockUpstream((request) => {
      if (request.headers.get("x-api-key") !== "sk-ant") {
        return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })
      }
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hello from anthropic" }],
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 9, output_tokens: 3 },
        }),
        { status: 200 },
      )
    })
    const env = await startServer(
      writePoolConfig([
        baseEntry({ id: "e1", base_url: broken.url, api_key: "k1" }),
        baseEntry({ id: "e2", adapter: "anthropic", base_url: anthropic.url, model: "claude-sonnet-4-6", api_key: "sk-ant" }),
      ]),
    )
    env.mocks.push(broken, anthropic)
    const response = await post(env.server, { model: "main", messages: [{ role: "user", content: "hi" }] })
    expect(response.status).toBe(200)
    const parsed = await jsonOf(response)
    expect(parsed.choices[0].message.content).toBe("hello from anthropic")
    expect(parsed.usage.total_tokens).toBe(12)
  })

  test("circuit breaker opens after two distinct keys are rate limited, then auto-resumes", async () => {
    let calls = 0
    const limited = mockUpstream(() => {
      calls++
      if (calls <= 2) return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })
      return new Response(chatJson("recovered after breaker"), { status: 200 })
    })
    const env = await startServer(
      writePoolConfig(
        [
          baseEntry({ id: "e1", base_url: limited.url, api_key: "k1" }),
          baseEntry({ id: "e2", base_url: limited.url, api_key: "k2" }),
        ],
        {
          provider_breaker_trigger: 2,
          provider_breaker_seconds: 1,
          rate_limit_cooldown_seconds: 1,
          exhaust_wait_timeout_seconds: 15,
        },
      ),
    )
    env.mocks.push(limited)
    const first = await post(env.server, { model: "main", messages: [{ role: "user", content: "hi" }] })
    expect(first.status).toBe(200)
    const parsed = await jsonOf(first)
    expect(parsed.choices[0].message.content).toBe("recovered after breaker")
    const healthRes = await fetch(`${env.server.url.replace(/\/$/, "")}/health`)
    const health = await jsonOf(healthRes)
    expect(health.stats.waits).toBeGreaterThan(0)
  })

  test("waits while all keys are cooling and auto-resumes when one clears", async () => {
    let calls = 0
    const limited = mockUpstream(() => {
      calls++
      if (calls <= 3) return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })
      return new Response(chatJson("back after cooldown"), { status: 200 })
    })
    const env = await startServer(
      writePoolConfig(
        [
          baseEntry({ id: "e1", base_url: limited.url, api_key: "k1" }),
          baseEntry({ id: "e2", base_url: limited.url, api_key: "k2" }),
        ],
        {
          provider_breaker_trigger: 0,
          rate_limit_cooldown_seconds: 1,
          exhaust_wait_timeout_seconds: 15,
        },
      ),
    )
    env.mocks.push(limited)
    const started = Date.now()
    const response = await post(env.server, { model: "main", messages: [{ role: "user", content: "hi" }] })
    expect(Date.now() - started).toBeGreaterThanOrEqual(800)
    expect(response.status).toBe(200)
    const parsed = await jsonOf(response)
    expect(parsed.choices[0].message.content).toBe("back after cooldown")
    const healthRes = await fetch(`${env.server.url.replace(/\/$/, "")}/health`)
    const health = await jsonOf(healthRes)
    expect(health.stats.waits).toBeGreaterThan(0)
    expect(health.stats.failovers).toBeGreaterThan(0)
  })

  test("gives up with 502 when the wait budget is exhausted", async () => {
    const limited = mockUpstream(() => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }))
    const env = await startServer(
      writePoolConfig(
        [baseEntry({ id: "e1", base_url: limited.url, api_key: "k1" })],
        { rate_limit_cooldown_seconds: 5, exhaust_wait_timeout_seconds: 1 },
      ),
    )
    env.mocks.push(limited)
    const response = await post(env.server, { model: "main", messages: [{ role: "user", content: "hi" }] })
    expect(response.status).toBe(502)
    const parsed = await jsonOf(response)
    expect(parsed.error.type).toBe("AllEntriesFailed")
    expect(parsed.error.last_upstream_error).toContain("429")
  })

  test("client errors pass through without failover", async () => {
    const strict = mockUpstream(() => new Response(JSON.stringify({ error: { message: "bad request body" } }), { status: 400 }))
    const env = await startServer(
      writePoolConfig([
        baseEntry({ id: "e1", base_url: strict.url, api_key: "k1" }),
        baseEntry({ id: "e2", base_url: strict.url, api_key: "k2" }),
      ]),
    )
    env.mocks.push(strict)
    const response = await post(env.server, { model: "main", messages: [{ role: "user", content: "hi" }] })
    expect(response.status).toBe(400)
    expect(strict.hits.length).toBe(1)
  })

  test("sessions stay sticky across requests", async () => {
    const upstream = mockUpstream((request) => {
      const key = request.headers.get("Authorization") ?? ""
      if (key === "Bearer k1") return new Response(JSON.stringify({ error: { message: "limited" } }), { status: 429 })
      return new Response(chatJson(`answered by ${key}`), { status: 200 })
    })
    const env = await startServer(
      writePoolConfig([
        baseEntry({ id: "e1", base_url: upstream.url, api_key: "k1" }),
        baseEntry({ id: "e2", base_url: upstream.url, api_key: "k2" }),
      ]),
    )
    env.mocks.push(upstream)
    const first = await post(env.server, { model: "main", messages: [{ role: "user", content: "hi" }] }, { "x-session-affinity": "sess-1" })
    expect(first.status).toBe(200)
    await Bun.sleep(2600)
    const second = await post(env.server, { model: "main", messages: [{ role: "user", content: "again" }] }, { "x-session-affinity": "sess-1" })
    const parsed = await jsonOf(second)
    expect(parsed.choices[0].message.content).toBe("answered by Bearer k2")
  })

  test("lists pools on /v1/models", async () => {
    const env = await startServer(writePoolConfig([baseEntry({ id: "e1", base_url: "http://127.0.0.1:1", api_key: "k1" })]))
    const response = await fetch(`${env.server.url.replace(/\/$/, "")}/v1/models`)
    expect(response.status).toBe(200)
    const parsed = await jsonOf(response)
    expect(parsed.data.map((model: { id: string }) => model.id)).toEqual(["main"])
  })

  test("unknown pool returns 404 with available pools", async () => {
    const env = await startServer(writePoolConfig([baseEntry({ id: "e1", base_url: "http://127.0.0.1:1", api_key: "k1" })]))
    const response = await post(env.server, { model: "nope", messages: [] })
    expect(response.status).toBe(404)
    const parsed = await jsonOf(response)
    expect(parsed.error.type).toBe("PoolNotFound")
  })

  test("streams OpenAI SSE chunks through unchanged", async () => {
    const upstream = mockUpstream(() => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"streamed"},"finish_reason":null}]}\n\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    })
    const env = await startServer(writePoolConfig([baseEntry({ id: "e1", base_url: upstream.url, api_key: "k1" })]))
    env.mocks.push(upstream)
    const response = await post(
      env.server,
      { model: "main", messages: [{ role: "user", content: "hi" }], stream: true },
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"content":"streamed"')
    expect(text).toContain("data: [DONE]")
  })

  test("translates Anthropic SSE streams to OpenAI chunks", async () => {
    const upstream = mockUpstream((request) => {
      if (!request.url.endsWith("/v1/messages")) {
        return new Response("not found", { status: 404 })
      }
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'))
          controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'))
          controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"bonjour"}}\n\n'))
          controller.enqueue(encoder.encode('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'))
          controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'))
          controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    })
    const env = await startServer(
      writePoolConfig([baseEntry({ id: "e1", adapter: "anthropic", base_url: upstream.url, model: "claude-sonnet-4-6", api_key: "sk-ant" })]),
    )
    env.mocks.push(upstream)
    const response = await post(
      env.server,
      { model: "main", messages: [{ role: "user", content: "hi" }], stream: true },
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"role":"assistant"')
    expect(text).toContain('"content":"bonjour"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain("data: [DONE]")
  })

  test("empty pool returns a clear error", async () => {
    const env = await startServer(writePoolConfig([]))
    const response = await post(env.server, { model: "main", messages: [] })
    expect(response.status).toBe(502)
    const parsed = await jsonOf(response)
    expect(parsed.error.type).toBe("PoolEmpty")
  })
})
