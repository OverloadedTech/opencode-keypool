import type { Entry } from "../config.ts"

export type ChatCompletionBody = {
  model: string
  messages: Record<string, unknown>[]
  stream?: boolean
  [key: string]: unknown
}

export type ClassifyResult = "auth" | "rate_limit" | "upstream" | "client"

export type UpstreamRequest = {
  url: string
  headers: Record<string, string>
  body: string
}

export type StreamState = {
  [key: string]: unknown
}

export type Adapter = {
  build(entry: Entry, body: ChatCompletionBody): UpstreamRequest
  classify(status: number, bodyText: string): ClassifyResult
  errorMessage(status: number, bodyText: string): string
  fromUpstream(bodyText: string, body: ChatCompletionBody): string
  createStreamState(): StreamState
  translateStream(data: string, state: StreamState): string | null
}

export function joinUrl(base: string, path: string, query: Record<string, string> = {}): string {
  const clean = base.replace(/\/+$/, "")
  const url = new URL(`${clean}/${path.replace(/^\/+/, "")}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}

export function parseJson<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export function errorPayload(message: string, type = "upstream_error", code = "route_upstream_error"): string {
  return JSON.stringify({ error: { message, type, code } })
}

export function chunkJSON(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}
