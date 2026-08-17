import { describe, expect, test } from "bun:test"
import { anthropicAdapter } from "../src/adapters/anthropic.ts"
import type { ChatCompletionBody } from "../src/adapters/types.ts"
import type { Entry } from "../src/config.ts"

const entry: Entry = {
  id: "a",
  label: "claude",
  adapter: "anthropic",
  base_url: "https://api.anthropic.com/v1",
  model: "claude-sonnet-4-6",
  api_key: "sk-ant-test",
  auth: "bearer",
  api_version: "",
  enabled: true,
  proxy: "",
  headers: {},
}

function body(messages: Record<string, unknown>[], extra: Record<string, unknown> = {}): ChatCompletionBody {
  return { model: "pool", messages, stream: false, ...extra }
}

describe("anthropic adapter request translation", () => {
  test("converts system, user, assistant and tool messages", () => {
    const request = anthropicAdapter.build(
      entry,
      body([
        { role: "system", content: "be helpful" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"temp": 4}' },
      ]),
    )
    expect(request.url).toBe("https://api.anthropic.com/v1/messages")
    expect(request.headers["x-api-key"]).toBe("sk-ant-test")
    const parsed = JSON.parse(request.body)
    expect(parsed.model).toBe("claude-sonnet-4-6")
    expect(parsed.system).toBe("be helpful")
    expect(parsed.messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Oslo" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"temp": 4}' }] },
    ])
  })

  test("passes tools, temperature, stop and max_tokens", () => {
    const request = anthropicAdapter.build(
      entry,
      body(
        [{ role: "user", content: "hi" }],
        {
          temperature: 0.4,
          top_p: 0.9,
          stop: ["END"],
          max_tokens: 2048,
          tools: [{ type: "function", function: { name: "lookup", description: "look up", parameters: { type: "object", properties: { q: { type: "string" } } } } }],
          tool_choice: "auto",
        },
      ),
    )
    const parsed = JSON.parse(request.body)
    expect(parsed.max_tokens).toBe(2048)
    expect(parsed.temperature).toBe(0.4)
    expect(parsed.top_p).toBe(0.9)
    expect(parsed.stop_sequences).toEqual(["END"])
    expect(parsed.tools).toEqual([{ name: "lookup", description: "look up", input_schema: { type: "object", properties: { q: { type: "string" } } } }])
    expect(parsed.tool_choice).toBe("auto")
  })

  test("converts image data urls to base64 blocks", () => {
    const request = anthropicAdapter.build(
      entry,
      body([
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          ],
        },
      ]),
    )
    const parsed = JSON.parse(request.body)
    expect(parsed.messages[0].content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ])
  })
})

describe("anthropic adapter response translation", () => {
  test("converts a text response to OpenAI chat completion shape", () => {
    const text = JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello there" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const out = JSON.parse(anthropicAdapter.fromUpstream(text, body([])))
    expect(out.object).toBe("chat.completion")
    expect(out.choices[0].message.content).toBe("hello there")
    expect(out.choices[0].finish_reason).toBe("stop")
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    expect(out.model).toBe("pool")
  })

  test("converts tool_use blocks to tool_calls", () => {
    const text = JSON.stringify({
      id: "msg_2",
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Oslo" } }],
      model: "claude-sonnet-4-6",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const out = JSON.parse(anthropicAdapter.fromUpstream(text, body([])))
    expect(out.choices[0].message.content).toBeNull()
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } },
    ])
    expect(out.choices[0].finish_reason).toBe("tool_calls")
  })

  test("classifies overloaded_error as rate limit", () => {
    expect(anthropicAdapter.classify(529, "{}")).toBe("rate_limit")
    expect(anthropicAdapter.classify(400, JSON.stringify({ error: { type: "overloaded_error" } }))).toBe("rate_limit")
    expect(anthropicAdapter.classify(401, "{}")).toBe("auth")
    expect(anthropicAdapter.classify(400, JSON.stringify({ error: { type: "invalid_request_error" } }))).toBe("client")
  })
})

describe("anthropic adapter stream translation", () => {
  function chunk(frames: (string | null)[]): string[] {
    return frames.filter((frame): frame is string => frame !== null)
  }

  test("emits role, content, finish and usage chunks in OpenAI SSE shape", () => {
    const state = anthropicAdapter.createStreamState()
    const events = [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "he" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "llo" } }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
      JSON.stringify({ type: "message_stop" }),
    ]
    const chunks = chunk(events.map((event) => anthropicAdapter.translateStream(event, state)))
    const role = JSON.parse(chunks[0]!.slice(6).trim())
    expect(role.choices[0].delta.role).toBe("assistant")
    expect(JSON.parse(chunks[1]!.slice(6).trim()).choices[0].delta.content).toBe("he")
    expect(JSON.parse(chunks[2]!.slice(6).trim()).choices[0].delta.content).toBe("llo")
    expect(chunks[3]).toContain('"finish_reason":"stop"')
    expect(JSON.parse(chunks[4]!.slice(6).trim()).usage.total_tokens).toBe(5)
  })

  test("emits incremental tool calls from input_json_delta", () => {
    const state = anthropicAdapter.createStreamState()
    anthropicAdapter.translateStream(JSON.stringify({ type: "message_start", message: {} }), state)
    const frames = chunk([
      anthropicAdapter.translateStream(
        JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_9", name: "lookup" } }),
        state,
      ),
      anthropicAdapter.translateStream(
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":' } }),
        state,
      ),
      anthropicAdapter.translateStream(
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"x"}' } }),
        state,
      ),
    ])
    const startParsed = JSON.parse(frames[0]!.slice(6).trim())
    expect(startParsed.choices[0].delta.tool_calls[0]).toMatchObject({ id: "toolu_9", type: "function", function: { name: "lookup" } })
    expect(JSON.parse(frames[1]!.slice(6).trim()).choices[0].delta.tool_calls[0].function.arguments).toBe('{"q":')
    expect(JSON.parse(frames[2]!.slice(6).trim()).choices[0].delta.tool_calls[0].function.arguments).toBe('"x"}')
  })
})
