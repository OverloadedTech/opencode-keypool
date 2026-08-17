import type { Entry } from "../config.ts"
import { joinUrl, parseJson } from "./types.ts"
import type { Adapter, ChatCompletionBody, ClassifyResult, StreamState, UpstreamRequest } from "./types.ts"

export function authHeaders(entry: Entry): Record<string, string> {
  if (entry.auth === "api-key") return { "api-key": entry.api_key }
  if (entry.auth === "none") return {}
  return { Authorization: `Bearer ${entry.api_key}` }
}

function buildOpenAI(entry: Entry, body: ChatCompletionBody): UpstreamRequest {
  const url = joinUrl(entry.base_url, "/chat/completions")
  const upstream = { ...body, model: entry.model }
  return {
    url,
    headers: { "Content-Type": "application/json", ...authHeaders(entry), ...entry.headers },
    body: JSON.stringify(upstream),
  }
}

function buildAzure(entry: Entry, body: ChatCompletionBody): UpstreamRequest {
  const query: Record<string, string> = {}
  if (entry.api_version) query["api-version"] = entry.api_version
  const url = joinUrl(entry.base_url, "/chat/completions", query)
  const upstream = { ...body, model: entry.model }
  return {
    url,
    headers: { "Content-Type": "application/json", "api-key": entry.api_key, ...entry.headers },
    body: JSON.stringify(upstream),
  }
}

function classify(status: number, bodyText: string): ClassifyResult {
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate_limit"
  if (status >= 500) return "upstream"
  const parsed = parseJson<{ error?: { type?: string; message?: string } }>(bodyText)
  if (status === 400 && parsed?.error?.type === "overloaded_error") return "rate_limit"
  return "client"
}

function errorMessage(status: number, bodyText: string): string {
  const parsed = parseJson<{ error?: { message?: string; type?: string } }>(bodyText)
  const message = parsed?.error?.message || parsed?.error?.type || bodyText.slice(0, 200)
  return `HTTP ${status}: ${message}`
}

export const openaiAdapter: Adapter = {
  build(entry, body) {
    return entry.adapter === "azure" ? buildAzure(entry, body) : buildOpenAI(entry, body)
  },
  classify,
  errorMessage,
  fromUpstream(bodyText) {
    return bodyText
  },
  createStreamState() {
    return {}
  },
  translateStream(data) {
    return `data: ${data.trim()}\n\n`
  },
}
