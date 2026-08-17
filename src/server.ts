import { adapterFor } from "./adapters/index.ts"
import type { Adapter, ChatCompletionBody } from "./adapters/types.ts"
import { backoffDelay, PoolEngine } from "./engine.ts"
import { configMtime, findPool, loadConfig, type PoolConfig } from "./config.ts"
import type { Entry } from "./config.ts"
import { fetchViaProxy } from "./proxy.ts"

export type KeypoolServer = {
  hostname: string
  port: number
  stop(): Promise<void>
  url: string
}

const RELOAD_INTERVAL_MS = 2000

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  })
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  })
}

export function sessionId(headers: Headers): string | null {
  return (
    headers.get("x-session-affinity") ||
    headers.get("x-opencode-session") ||
    headers.get("x-session-id") ||
    headers.get("x-request-id")
  )
}

function breakerResponse(engine: PoolEngine, retryAfter: number): Response {
  const breaker = engine.breaker()
  return jsonResponse(
    429,
    {
      error: {
        type: "ProviderCooldown",
        message: "Keypool circuit breaker is open: too many distinct keys were rate limited.",
        retry_after: retryAfter,
        reason: breaker.reason,
      },
    },
    { "Retry-After": String(retryAfter) },
  )
}

function poolMissingResponse(available: string[]): Response {
  return jsonResponse(404, {
    error: {
      type: "PoolNotFound",
      message: `Unknown keypool model. Available pools: ${available.join(", ") || "none configured"}`,
    },
  })
}

function clientErrorResponse(status: number, text: string): Response {
  let body = text
  try {
    JSON.parse(text)
    body = text
  } catch {
    body = JSON.stringify({ error: { message: text.slice(0, 400), type: "upstream_client_error" } })
  }
  return new Response(body, { status, headers: { "Content-Type": "application/json" } })
}

async function readUpstreamError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "")
  return text
}

function streamErrorResponse(message: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: "keypool_error" } })}\n\n`))
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return sseResponse(stream)
}

function exhaustedResponse(text: string): Response {
  return jsonResponse(502, {
    error: {
      message: "All entries in the pool failed and the wait budget was exhausted.",
      last_upstream_error: text.slice(0, 400),
      type: "AllEntriesFailed",
    },
  })
}

async function runRequest(
  config: PoolConfig,
  engine: PoolEngine,
  body: ChatCompletionBody,
  session: string | null,
  poolId: string,
): Promise<Response> {
  const pool = findPool(config, poolId)
  if (!pool) return poolMissingResponse(config.pools.map((candidate) => candidate.id))
  if (pool.entries.length === 0) {
    return jsonResponse(502, { error: { message: `Pool "${poolId}" has no entries. Add keys with "oc-keypool tui".`, type: "PoolEmpty" } })
  }
  engine.recordRequest()
  const startedAt = Date.now()
  const budgetMs = config.exhaust_wait_timeout_seconds * 1000
  const tried = new Set<string>()
  let lastError: { status: number; text: string } | null = null
  let attempt = 0
  for (;;) {
    const breaker = engine.breaker()
    if (breaker.active) {
      const wait = breaker.remaining
      if (budgetOver(startedAt, wait * 1000, budgetMs)) return exhaustedResponse(breaker.reason || "circuit breaker open")
      engine.recordWait()
      await Bun.sleep(wait * 1000)
      continue
    }
    const entry = engine.pick(poolId, session, tried)
    if (!entry) {
      const waitSeconds = engine.exhaustionWaitSeconds(poolId)
      const pollMs = waitSeconds > 0 ? waitSeconds * 1000 : 2000
      if (budgetOver(startedAt, pollMs, budgetMs)) return exhaustedResponse(lastError?.text ?? "")
      engine.recordWait()
      await Bun.sleep(pollMs)
      tried.clear()
      continue
    }
    tried.add(entry.id)
    if (attempt > 0) engine.recordFailover()
    attempt++
    const result = await attemptEntry(config, engine, entry, body, session, poolId)
    if (result.response) return result.response
    lastError = result.error ?? null
    const delay = backoffDelay(config.retry_backoff, attempt)
    if (delay > 0) await Bun.sleep(Math.floor(delay * 1000))
  }
}

function budgetOver(startedAt: number, waitMs: number, budgetMs: number): boolean {
  if (budgetMs <= 0) return false
  return Date.now() - startedAt + waitMs > budgetMs
}

async function attemptEntry(
  config: PoolConfig,
  engine: PoolEngine,
  entry: Entry,
  body: ChatCompletionBody,
  session: string | null,
  poolId: string,
): Promise<{ response?: Response; error?: { status: number; text: string } }> {
  const adapter = adapterFor(entry)
  let request
  try {
    request = adapter.build(entry, body)
  } catch (error) {
    return { error: { status: 400, text: `Failed to build upstream request: ${String(error)}` } }
  }
  let response: Response
  const timeoutMs = config.upstream_timeout_seconds * 1000
  try {
    const init = {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    }
    response = entry.proxy ? await fetchViaProxy(request.url, init, entry.proxy, timeoutMs) : await fetch(request.url, init)
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    engine.onUpstreamError(entry.id, message, session)
    return { error: { status: 502, text: message } }
  }
  if (!response.ok) {
    const text = await readUpstreamError(response)
    const kind = adapter.classify(response.status, text)
    const message = adapter.errorMessage(response.status, text)
    if (kind === "auth") {
      engine.onAuthFailure(entry.id, message, session)
    } else if (kind === "rate_limit") {
      engine.onRateLimit(entry.id, message, session)
    } else if (kind === "upstream") {
      engine.onUpstreamError(entry.id, message, session)
    } else {
      return { response: clientErrorResponse(response.status, text) }
    }
    return { error: { status: response.status, text: message } }
  }
  engine.onSuccess(entry.id)
  if (session) engine.rememberSession(session, entry.id)
  if (body.stream === true && response.body) {
    return { response: sseResponse(pipeStream(adapter, entry, response, engine, body, poolId)) }
  }
  const text = await response.text().catch(() => "")
  return {
    response: new Response(adapter.fromUpstream(text, body), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-keypool-entry": entry.label,
        "x-keypool-pool": poolId,
      },
    }),
  }
}

function pipeStream(
  adapter: Adapter,
  entry: Entry,
  upstream: Response,
  engine: PoolEngine,
  body: ChatCompletionBody,
  poolId: string,
): ReadableStream<Uint8Array> {
  const reader = upstream.body!.getReader()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const state = adapter.createStreamState()
  let buffer = ""
  let sentDone = false
  const isPassthrough = entry.adapter !== "anthropic"
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sentDone) return
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        engine.onUpstreamError(entry.id, message)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: `Upstream stream failed: ${message}`, type: "keypool_stream_error" } })}\n\n`))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        sentDone = true
        controller.close()
        return
      }
      if (chunk.done) {
        if (sentDone) {
          controller.close()
          return
        }
        if (!isPassthrough) {
          const final = adapter.translateStream(buffer, state)
          if (final) controller.enqueue(encoder.encode(final))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        }
        sentDone = true
        controller.close()
        return
      }
      if (isPassthrough) {
        controller.enqueue(chunk.value)
        return
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      const parts = buffer.split("\n\n")
      buffer = parts.pop() ?? ""
      for (const part of parts) {
        const dataLines = part
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
        for (const data of dataLines) {
          const translated = adapter.translateStream(data, state)
          if (translated) controller.enqueue(encoder.encode(translated))
        }
      }
    },
  })
}

export function serve(configPath?: string, portOverride?: number): KeypoolServer {
  let config = configPath ? loadConfig(configPath) : loadConfig()
  if (portOverride) config.port = portOverride
  const engine = new PoolEngine(config)
  const startedAt = Date.now()
  let lastMtime = configPath ? configMtime(configPath) : configMtime()
  const reloadTimer = setInterval(() => {
    const mtime = configPath ? configMtime(configPath) : configMtime()
    if (mtime !== lastMtime) {
      lastMtime = mtime
      const fresh = configPath ? loadConfig(configPath) : loadConfig()
      if (fresh.port !== config.port) {
        console.warn(`[keypool] config port changed to ${fresh.port}; restart the daemon to apply`)
      }
      config = { ...fresh, port: config.port }
      engine.reload(config)
    }
  }, RELOAD_INTERVAL_MS)

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    development: false,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/health") {
        const breaker = engine.breaker()
        return jsonResponse(200, {
          ok: true,
          version: "0.1.0",
          uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
          port: config.port,
          pools: config.pools.map((pool) => ({ id: pool.id, label: pool.label, entries: pool.entries.length })),
          breaker,
          entries: engine.status(),
          stats: engine.stats,
        })
      }
      if (request.method === "GET" && url.pathname === "/stats") {
        return jsonResponse(200, { breaker: engine.breaker(), stats: engine.stats, entries: engine.status() })
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return jsonResponse(200, {
          object: "list",
          data: config.pools.map((pool) => ({
            id: pool.id,
            object: "model",
            created: Math.floor(startedAt / 1000),
            owned_by: "keypool",
            name: pool.label,
          })),
        })
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = (await request.json().catch(() => null)) as ChatCompletionBody | null
        if (!body || !Array.isArray(body.messages)) {
          return jsonResponse(400, { error: { message: "Invalid chat completion request.", type: "invalid_request_error" } })
        }
        const poolId = typeof body.model === "string" ? body.model : ""
        if (!poolId) {
          return jsonResponse(400, { error: { message: "Missing model (pool) in request body.", type: "invalid_request_error" } })
        }
        const session = sessionId(request.headers)
        return runRequest(config, engine, body, session, poolId)
      }
      return jsonResponse(404, { error: { message: `Not found: ${request.method} ${url.pathname}`, type: "not_found" } })
    },
  })

  return {
    hostname: "127.0.0.1",
    port: server.port ?? config.port,
    url: server.url.toString(),
    async stop() {
      clearInterval(reloadTimer)
      await server.stop()
    },
  }
}
