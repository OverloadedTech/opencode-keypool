import type { Entry } from "../config.ts"
import { joinUrl, parseJson } from "./types.ts"
import type { Adapter, ChatCompletionBody, ClassifyResult, StreamState, UpstreamRequest } from "./types.ts"

export type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }

type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicBlock[] }

type AnthropicRequest = {
  model: string
  system?: string
  messages: AnthropicMessage[]
  max_tokens: number
  stream: boolean
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  tools?: { name: string; description?: string; input_schema: Record<string, unknown> }[]
  tool_choice?: { type: string; name?: string } | "auto" | "any" | "none"
}

type AnthropicResponse = {
  id: string
  type: string
  role: string
  content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]
  model: string
  stop_reason: string | null
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

const ANTHROPIC_VERSION = "2023-06-01"

function textFromPart(part: Record<string, unknown>): string | null {
  if (typeof part.text === "string") return part.text
  return null
}

function imageBlockFromPart(part: Record<string, unknown>): AnthropicBlock | null {
  const url = typeof part.image_url === "object" && part.image_url !== null
    ? (part.image_url as Record<string, unknown>).url
    : null
  if (typeof url !== "string") return null
  if (url.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(url)
    if (!match) return null
    const mediaType = match[1] ?? "image/png"
    return { type: "image", source: { type: "base64", media_type: mediaType, data: match[2] ?? "" } }
  }
  return { type: "image", source: { type: "url", url } }
}

function documentBlockFromPart(part: Record<string, unknown>): AnthropicBlock | null {
  const file = part.file
  if (typeof file !== "object" || file === null) return null
  const data = (file as Record<string, unknown>).file_data
  if (typeof data !== "string") return null
  const match = /^data:([^;]+);base64,(.*)$/s.exec(data)
  if (!match) return null
  return { type: "document", source: { type: "base64", media_type: match[1] ?? "application/pdf", data: match[2] ?? "" } }
}

function userContent(message: Record<string, unknown>): string | AnthropicBlock[] {
  const content = message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const blocks: AnthropicBlock[] = []
  for (const part of content as Record<string, unknown>[]) {
    const text = textFromPart(part)
    if (text !== null) {
      blocks.push({ type: "text", text })
      continue
    }
    const image = imageBlockFromPart(part)
    if (image) {
      blocks.push(image)
      continue
    }
    const document = documentBlockFromPart(part)
    if (document) blocks.push(document)
  }
  return blocks
}

function toolUses(message: Record<string, unknown>): AnthropicBlock[] {
  const calls = message.tool_calls
  if (!Array.isArray(calls)) return []
  return calls.map((call) => {
    const raw = call as Record<string, unknown>
    const fn = typeof raw.function === "object" && raw.function !== null ? (raw.function as Record<string, unknown>) : {}
    const id = typeof raw.id === "string" ? raw.id : `call_${Math.random().toString(36).slice(2, 10)}`
    let input: Record<string, unknown> = {}
    if (typeof fn.arguments === "string") input = parseJson<Record<string, unknown>>(fn.arguments) ?? {}
    return { type: "tool_use", id, name: typeof fn.name === "string" ? fn.name : "", input }
  })
}

function toAnthropicMessages(messages: Record<string, unknown>[]): { system: string[]; messages: AnthropicMessage[] } {
  const system: string[] = []
  const out: AnthropicMessage[] = []
  for (const message of messages) {
    const role = message.role
    if (role === "system" || role === "developer") {
      if (typeof message.content === "string") system.push(message.content)
      else if (Array.isArray(message.content)) {
        for (const part of message.content as Record<string, unknown>[]) {
          const text = textFromPart(part)
          if (text !== null) system.push(text)
        }
      }
      continue
    }
    if (role === "tool") {
      const content = message.content
      const block: AnthropicBlock = {
        type: "tool_result",
        tool_use_id: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
        content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
      }
      const last = out[out.length - 1]
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block)
      } else {
        out.push({ role: "user", content: [block] })
      }
      continue
    }
    if (role === "assistant") {
      const blocks: AnthropicBlock[] = []
      if (typeof message.content === "string" && message.content) blocks.push({ type: "text", text: message.content })
      else if (Array.isArray(message.content)) {
        for (const part of message.content as Record<string, unknown>[]) {
          const text = textFromPart(part)
          if (text !== null && text) blocks.push({ type: "text", text })
        }
      }
      blocks.push(...toolUses(message))
      if (blocks.length === 0) blocks.push({ type: "text", text: "" })
      out.push({ role: "assistant", content: blocks })
      continue
    }
    if (role === "user") {
      const content = userContent(message)
      const last = out[out.length - 1]
      if (last && last.role === "user" && Array.isArray(last.content) && Array.isArray(content)) {
        last.content.push(...content)
      } else {
        out.push({ role: "user", content })
      }
    }
  }
  const first = out[0]
  if (first && first.role === "assistant") {
    out.unshift({ role: "user", content: "(conversation start)" })
  }
  return { system, messages: out }
}

function mapToolChoice(body: ChatCompletionBody): AnthropicRequest["tool_choice"] {
  const choice = body.tool_choice
  if (choice === "none") return "none"
  if (choice === "required" || choice === "any") return "any"
  if (typeof choice === "object" && choice !== null) {
    const raw = choice as Record<string, unknown>
    if (typeof raw.function === "object" && raw.function !== null) {
      const name = (raw.function as Record<string, unknown>).name
      if (typeof name === "string") return { type: "tool", name }
    }
  }
  return "auto"
}

function build(entry: Entry, body: ChatCompletionBody): UpstreamRequest {
  const { system, messages } = toAnthropicMessages(body.messages)
  const request: AnthropicRequest = {
    model: entry.model,
    messages,
    max_tokens: 4096,
    stream: body.stream === true,
  }
  if (typeof body.system === "string" && body.system) request.system = body.system
  else if (system.length > 0) request.system = system.join("\n\n")
  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : null
  if (maxTokens) request.max_tokens = maxTokens
  if (typeof body.temperature === "number") request.temperature = body.temperature
  if (typeof body.top_p === "number") request.top_p = body.top_p
  if (Array.isArray(body.stop)) request.stop_sequences = body.stop.filter((item): item is string => typeof item === "string")
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    request.tools = body.tools.map((tool) => {
      const fn = typeof tool.function === "object" && tool.function !== null ? (tool.function as Record<string, unknown>) : {}
      return {
        name: typeof fn.name === "string" ? fn.name : "",
        description: typeof fn.description === "string" ? fn.description : undefined,
        input_schema: typeof fn.parameters === "object" && fn.parameters !== null ? (fn.parameters as Record<string, unknown>) : { type: "object", properties: {} },
      }
    })
    request.tool_choice = mapToolChoice(body)
  }
  return {
    url: joinUrl(entry.base_url, entry.base_url.endsWith("/v1") ? "/messages" : "/v1/messages"),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": entry.api_key,
      "anthropic-version": ANTHROPIC_VERSION,
      ...entry.headers,
    },
    body: JSON.stringify(request),
  }
}

function finishReason(stop: string | null): string {
  switch (stop) {
    case "tool_use": return "tool_calls"
    case "max_tokens": return "length"
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    default:
      return "stop"
  }
}

function toOpenAIResponse(text: string, body: ChatCompletionBody): string {
  const parsed = parseJson<AnthropicResponse>(text)
  if (!parsed) return text
  const texts: string[] = []
  const toolCalls: Record<string, unknown>[] = []
  for (const block of parsed.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text)
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        type: "function",
        function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }
  const usage = parsed.usage
  const promptTokens = usage ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0
  const completionTokens = usage?.output_tokens ?? 0
  return JSON.stringify({
    id: parsed.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: texts.length > 0 ? texts.join("\n\n") : null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: finishReason(parsed.stop_reason),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  })
}

function classify(status: number, bodyText: string): ClassifyResult {
  if (status === 401 || status === 403) return "auth"
  if (status === 429 || status === 529) return "rate_limit"
  if (status >= 500) return "upstream"
  const parsed = parseJson<{ error?: { type?: string } }>(bodyText)
  if (parsed?.error?.type === "overloaded_error") return "rate_limit"
  if (parsed?.error?.type === "api_error") return "upstream"
  return "client"
}

function errorMessage(status: number, bodyText: string): string {
  const parsed = parseJson<{ error?: { message?: string; type?: string } }>(bodyText)
  return `HTTP ${status}: ${parsed?.error?.message || parsed?.error?.type || bodyText.slice(0, 200)}`
}

type AnthropicStreamShape = {
  started: boolean
  toolCounter: number
  toolIndexByBlock: Map<number, number>
  usage: { input_tokens: number; output_tokens: number } | null
  done: boolean
}

function createStreamState(): StreamState {
  return { anthropic: { started: false, toolCounter: 0, toolIndexByBlock: new Map(), usage: null, done: false } satisfies AnthropicStreamShape }
}

function streamShape(state: StreamState): AnthropicStreamShape {
  const shape = state.anthropic as AnthropicStreamShape | undefined
  if (shape) return shape
  const fresh: AnthropicStreamShape = { started: false, toolCounter: 0, toolIndexByBlock: new Map(), usage: null, done: false }
  state.anthropic = fresh
  return fresh
}

function openAIUsage(usage: AnthropicStreamShape["usage"]): Record<string, number> | null {
  if (!usage) return null
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.input_tokens + usage.output_tokens,
  }
}

function roleChunk(): string {
  return JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })
}

function contentChunk(text: string): string {
  return JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
}

function toolCallChunk(index: number, patch: Record<string, unknown>): string {
  return JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index, ...patch }] }, finish_reason: null }] })
}

function translateStream(data: string, state: StreamState): string | null {
  const s = streamShape(state)
  if (s.done) return null
  const event = parseJson<Record<string, unknown> & { type?: string }>(data)
  if (!event) return null
  switch (event.type) {
    case "ping": return null
    case "message_start": {
      if (s.started) return null
      s.started = true
      const message = event.message
      if (typeof message === "object" && message !== null) {
        const usage = (message as Record<string, unknown>).usage
        if (typeof usage === "object" && usage !== null) {
          const raw = usage as Record<string, unknown>
          if (typeof raw.input_tokens === "number" && typeof raw.output_tokens === "number") {
            s.usage = { input_tokens: raw.input_tokens, output_tokens: raw.output_tokens }
          }
        }
      }
      return `data: ${roleChunk()}\n\n`
    }
    case "content_block_start": {
      const block = event.content_block
      if (typeof block !== "object" || block === null) return null
      const raw = block as Record<string, unknown>
      if (raw.type === "tool_use") {
        const index = typeof event.index === "number" ? event.index : 0
        const toolIndex = s.toolCounter++
        s.toolIndexByBlock.set(index, toolIndex)
        return `data: ${toolCallChunk(toolIndex, {
          id: typeof raw.id === "string" ? raw.id : `call_${toolIndex}`,
          type: "function",
          function: { name: typeof raw.name === "string" ? raw.name : "", arguments: "" },
        })}\n\n`
      }
      return null
    }
    case "content_block_delta": {
      const delta = event.delta
      if (typeof delta !== "object" || delta === null) return null
      const raw = delta as Record<string, unknown>
      if (raw.type === "text_delta" && typeof raw.text === "string") {
        return `data: ${contentChunk(raw.text)}\n\n`
      }
      if (raw.type === "input_json_delta" && typeof raw.partial_json === "string") {
        const index = typeof event.index === "number" ? event.index : 0
        const toolIndex = s.toolIndexByBlock.get(index) ?? 0
        return `data: ${toolCallChunk(toolIndex, { function: { arguments: raw.partial_json } })}\n\n`
      }
      return null
    }
    case "message_delta": {
      const delta = event.delta
      const usage = event.usage
      let frames = ""
      if (typeof delta === "object" && delta !== null) {
        const raw = delta as Record<string, unknown>
        const reason = finishReason(typeof raw.stop_reason === "string" ? raw.stop_reason : null)
        frames += `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`
      }
      if (typeof usage === "object" && usage !== null) {
        const raw = usage as Record<string, unknown>
        if (typeof raw.output_tokens === "number") {
          s.usage = { input_tokens: s.usage?.input_tokens ?? 0, output_tokens: raw.output_tokens }
        }
      }
      return frames
    }
    case "message_stop": {
      s.done = true
      const usage = openAIUsage(s.usage)
      if (usage) return `data: ${JSON.stringify({ choices: [], usage })}\n\n`
      return null
    }
    case "error": {
      s.done = true
      const err = event.error
      const message = typeof err === "object" && err !== null ? ((err as Record<string, unknown>).message as string | undefined) ?? "anthropic stream error" : "anthropic stream error"
      return `data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`
    }
    default:
      return null
  }
}

export const anthropicAdapter: Adapter = {
  build,
  classify,
  errorMessage,
  fromUpstream: toOpenAIResponse,
  createStreamState,
  translateStream,
}
