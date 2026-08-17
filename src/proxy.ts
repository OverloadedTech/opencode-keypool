import { connect } from "node:net"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { connect as tlsConnect } from "node:tls"
import { Readable } from "node:stream"
import type { Duplex } from "node:stream"

export type ProxyTarget = {
  host: string
  port: number
  tls: boolean
  path: string
}

type Waiter = { length: number; resolve: (buf: Buffer) => void; reject: (error: Error) => void }

class BufferedSocket {
  private buffer: Buffer = Buffer.alloc(0)
  private waiters: Waiter[] = []
  private error: Error | null = null

  constructor(socket: Duplex) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.flush()
    })
    socket.on("error", (error) => {
      this.error = error
      for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    })
    socket.on("close", () => {
      this.error = this.error ?? new Error("connection closed")
      for (const waiter of this.waiters.splice(0)) waiter.reject(this.error)
    })
  }

  private flush() {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]
      if (!waiter) return
      if (this.buffer.length < waiter.length) return
      const out = this.buffer.subarray(0, waiter.length)
      this.buffer = this.buffer.subarray(waiter.length)
      this.waiters.shift()
      waiter.resolve(out)
    }
  }

  read(length: number): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error)
    if (this.buffer.length >= length) {
      const out = this.buffer.subarray(0, length)
      this.buffer = this.buffer.subarray(length)
      return Promise.resolve(out)
    }
    return new Promise((resolve, reject) => this.waiters.push({ length, resolve, reject }))
  }
}

export function parseProxyUrl(raw: string): { type: "http" | "socks5"; host: string; port: number; auth: { user: string; pass: string } | null } {
  const url = new URL(raw)
  const type = url.protocol === "socks5:" ? "socks5" : "http"
  const host = url.hostname
  const port = Number(url.port || (url.protocol === "socks5:" ? 1080 : 3128))
  const auth = url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : null
  return { type, host, port, auth }
}

export function targetFromUrl(raw: string): ProxyTarget {
  const url = new URL(raw)
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  return { host: url.hostname, port, tls: url.protocol === "https:", path: `${url.pathname}${url.search}` }
}

async function readUntilDoubleNewline(reader: BufferedSocket): Promise<string> {
  let text = ""
  for (;;) {
    const chunk = await reader.read(1)
    text += chunk.toString("latin1")
    const idx = text.indexOf("\r\n\r\n")
    if (idx >= 0) return text.slice(0, idx)
  }
}

async function httpConnectTunnel(
  proxy: { host: string; port: number; auth: { user: string; pass: string } | null },
  target: ProxyTarget,
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port })
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    socket.on("error", fail)
    socket.on("connect", () => {
      let request = `CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n`
      if (proxy.auth) request += `Proxy-Authorization: Basic ${Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString("base64")}\r\n`
      request += "\r\n"
      socket.write(request)
      readUntilDoubleNewline(new BufferedSocket(socket)).then(
        (head) => {
          const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? 0)
          if (status !== 200) {
            fail(new Error(`proxy CONNECT failed: ${head.split("\r\n")[0] ?? "unknown status"}`))
            return
          }
          socket.off("error", fail)
          settled = true
          resolve(socket)
        },
        fail,
      )
    })
  })
}

async function socks5Tunnel(
  proxy: { host: string; port: number; auth: { user: string; pass: string } | null },
  target: ProxyTarget,
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port })
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    socket.on("error", fail)
    socket.on("connect", () => {
      const reader = new BufferedSocket(socket)
      const methods = proxy.auth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00])
      socket.write(methods)
      reader.read(2).then(
        async (reply) => {
          if (reply[0] !== 0x05) return fail(new Error("socks5 handshake failed"))
          if (reply[1] === 0xff) return fail(new Error("socks5: no acceptable auth method"))
          if (reply[1] === 0x02 && proxy.auth) {
            const user = Buffer.from(proxy.auth.user)
            const pass = Buffer.from(proxy.auth.pass)
            socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
            const authReply = await reader.read(2).catch(fail)
            if (!authReply) return
            if (authReply[1] !== 0x00) return fail(new Error("socks5 auth failed"))
          }
          const host = Buffer.from(target.host)
          const port = Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff])
          socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]))
          const head = await reader.read(4).catch(fail)
          if (!head) return
          if (head[1] !== 0x00) return fail(new Error(`socks5 connect failed with code 0x${(head[1] ?? 0).toString(16)}`))
          const atyp = head[3]
          const addressLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : target.host.length + 2
          await reader.read(addressLen + 2).catch(fail)
          socket.off("error", fail)
          settled = true
          resolve(socket)
        },
        fail,
      )
    })
  })
}

function wrapTls(socket: Duplex, target: ProxyTarget): Duplex {
  return tlsConnect({ socket, servername: target.host })
}

function headersFromMessage(message: { headers: NodeJS.Dict<string | string[]> }): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(message.headers)) {
    if (!value) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.set(key, value)
    }
  }
  return headers
}

function nodeRequest(target: ProxyTarget, socket: Duplex, init: RequestInit, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (init.headers) {
      const fromHeaders = init.headers instanceof Headers ? init.headers : new Headers(init.headers as Record<string, string>)
      for (const [key, value] of fromHeaders.entries()) headers[key] = value
    }
    const options = {
      createConnection: () => socket,
      host: target.host,
      port: target.port,
      method: "POST",
      path: target.path,
      headers: { ...headers, Host: target.host },
      agent: false,
    }
    const requester = target.tls ? httpsRequest : httpRequest
    const req = requester(options)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`upstream timeout after ${timeoutMs}ms`)))
    if (init.signal) {
      init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true })
    }
    req.on("response", (message) => {
      const body = Readable.toWeb(message) as ReadableStream<Uint8Array>
      resolve(new Response(body, { status: message.statusCode ?? 502, headers: headersFromMessage(message) }))
    })
    req.on("error", reject)
    req.end(typeof init.body === "string" ? init.body : undefined)
  })
}

export async function fetchViaProxy(rawUrl: string, init: RequestInit, proxyRaw: string, timeoutMs: number): Promise<Response> {
  const proxy = parseProxyUrl(proxyRaw)
  const target = targetFromUrl(rawUrl)
  const tunnel = proxy.type === "socks5" ? await socks5Tunnel(proxy, target) : await httpConnectTunnel(proxy, target)
  const socket = target.tls ? wrapTls(tunnel, target) : tunnel
  return nodeRequest(target, socket, init, timeoutMs)
}
