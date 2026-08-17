import type { Entry } from "../config.ts"
import { anthropicAdapter } from "./anthropic.ts"
import { openaiAdapter } from "./openai.ts"
import type { Adapter } from "./types.ts"

export function adapterFor(entry: Entry): Adapter {
  return entry.adapter === "anthropic" ? anthropicAdapter : openaiAdapter
}

export { anthropicAdapter, openaiAdapter }
export * from "./types.ts"
