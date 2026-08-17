import { afterEach, describe, expect, test } from "bun:test"
import { createServer, connect } from "node:net"
import type { AddressInfo } from "node:net"
import { fetchViaProxy } from "../src/proxy.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function startUpstream(): { port: number; requests: { path: string; auth: string }[] } {
  const requests: { path: string; auth: string }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({ path: new URL(request.url).pathname + new URL(request.url).search, auth: request.headers.get("authorization") ?? "" })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })
    },
  })
  cleanups.push(() => server.stop(true))
  return { port: server.port ?? 0, requests }
}

function startConnectProxy(): number {
  const server = createServer((client) => {
    let buffer = ""
    client.on("error", () => {})
    client.on("data", (chunk) => {
      buffer += chunk.toString()
      const idx = buffer.indexOf("\r\n\r\n")
      if (idx < 0) return
      const match = /^CONNECT ([^:]+):(\d+)/.exec(buffer.slice(0, idx))
      if (!match) {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n")
        return
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      const upstream = connect({ host: match[1], port: Number(match[2]) })
      upstream.on("error", () => client.destroy())
      client.pipe(upstream)
      upstream.pipe(client)
    })
  })
  server.listen(0, "127.0.0.1")
  const port = (server.address() as AddressInfo).port
  cleanups.push(() => server.close())
  return port
}

function startSocks5Proxy(): number {
  const server = createServer((client) => {
    let stage: "greeting" | "connect" = "greeting"
    client.on("error", () => {})
    client.on("data", (chunk: Buffer) => {
      if (stage === "greeting") {
        stage = "connect"
        client.write(Buffer.from([0x05, 0x00]))
        if (chunk.length > 3) client.emit("data", chunk.subarray(3))
        return
      }
      const hostLen = chunk[4] ?? 0
      const host = chunk.subarray(5, 5 + hostLen).toString()
      const port = chunk.readUInt16BE(5 + hostLen)
      const upstream = connect({ host, port })
      upstream.on("error", () => client.destroy())
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
      client.pipe(upstream)
      upstream.pipe(client)
    })
  })
  server.listen(0, "127.0.0.1")
  const port = (server.address() as AddressInfo).port
  cleanups.push(() => server.close())
  return port
}

describe("fetchViaProxy", () => {
  test("tunnels through an HTTP CONNECT proxy preserving path, query and auth headers", async () => {
    const upstream = startUpstream()
    const proxyPort = startConnectProxy()
    const response = await fetchViaProxy(
      `http://127.0.0.1:${upstream.port}/chat/completions?x=1`,
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer k" }, body: "{}" },
      `http://127.0.0.1:${proxyPort}`,
      5000,
    )
    expect(response.status).toBe(200)
    expect(upstream.requests[0]).toEqual({ path: "/chat/completions?x=1", auth: "Bearer k" })
  })

  test("tunnels through a SOCKS5 proxy", async () => {
    const upstream = startUpstream()
    const proxyPort = startSocks5Proxy()
    const response = await fetchViaProxy(
      `http://127.0.0.1:${upstream.port}/v1/messages`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      `socks5://127.0.0.1:${proxyPort}`,
      5000,
    )
    expect(response.status).toBe(200)
    expect(upstream.requests[0]?.path).toBe("/v1/messages")
  })

  test("fails with a clear error when the proxy refuses the CONNECT", async () => {
    const upstream = startUpstream()
    void upstream
    const server = createServer((client) => {
      client.on("error", () => {})
      client.on("data", () => client.end("HTTP/1.1 403 Forbidden\r\n\r\n"))
    })
    server.listen(0, "127.0.0.1")
    const port = (server.address() as AddressInfo).port
    cleanups.push(() => server.close())
    await expect(
      fetchViaProxy("http://example.invalid/chat/completions", { method: "POST", body: "{}" }, `http://127.0.0.1:${port}`, 2000),
    ).rejects.toThrow(/CONNECT failed/)
  })
})
