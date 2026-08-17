import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { daemonPid, findBun, health, waitForHealth } from "./daemon.ts"
import { LOG_PATH, PID_PATH, STATE_DIR } from "./config.ts"

type PluginConfig = {
  provider?: Record<string, unknown>
  [key: string]: unknown
}

type PluginInput = {
  config: PluginConfig
  directory: string
  $: { [key: string]: (...args: unknown[]) => unknown }
}

export type KeypoolPlugin = (input: PluginInput) => Promise<Record<string, never>>

export const PLUGIN_CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME || join(process.env.HOME || "/", ".config"),
  "opencode-keypool",
)
export const PLUGIN_CONFIG_PATH = join(PLUGIN_CONFIG_DIR, "config.json")

const HEALTH_TIMEOUT_MS = 600
const START_WAIT_MS = 4000

type PoolConfigFile = {
  port: number
  pools?: { id: string; label: string; entries: unknown[] }[]
}

function readConfig(): PoolConfigFile {
  try {
    const parsed = JSON.parse(readFileSync(PLUGIN_CONFIG_PATH, "utf8")) as PoolConfigFile
    if (typeof parsed.port !== "number") return { port: 4777, pools: [] }
    return parsed
  } catch {
    return { port: 4777, pools: [] }
  }
}

function writeBootstrap(config: PoolConfigFile): void {
  try {
    mkdirSync(PLUGIN_CONFIG_DIR, { recursive: true, mode: 0o700 })
    if (!existsSync(PLUGIN_CONFIG_PATH)) {
      writeFileSync(
        PLUGIN_CONFIG_PATH,
        JSON.stringify(
          {
            port: config.port,
            cooldown_seconds: 60,
            max_failures: 5,
            rate_limit_cooldown_seconds: 60,
            auth_fail_cooldown_seconds: 1800,
            provider_breaker_trigger: 2,
            provider_breaker_seconds: 900,
            retry_backoff: [0.4, 0.8, 1.5, 3.0],
            upstream_timeout_seconds: 600,
            pools: config.pools ?? [],
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      )
    }
  } catch {
    // best-effort bootstrap; the TUI creates the config on first run
  }
}

async function ensureDaemon(port: number): Promise<void> {
  if (await health(port, HEALTH_TIMEOUT_MS)) return
  const pid = daemonPid()
  if (pid) return
  const bun = findBun()
  if (!bun) return
  const cli = new URL("./cli.ts", import.meta.url).pathname
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const logFd = openSync(LOG_PATH, "a")
  const proc = Bun.spawn([bun, cli, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  })
  proc.unref()
  writeFileSync(PID_PATH, String(proc.pid), { mode: 0o600 })
  await waitForHealth(port, START_WAIT_MS)
}

function poolModels(config: PoolConfigFile): Record<string, Record<string, unknown>> {
  const models: Record<string, Record<string, unknown>> = {}
  for (const pool of config.pools ?? []) {
    if (!pool || typeof pool.id !== "string") continue
    models[pool.id] = {
      name: pool.label || pool.id,
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      limit: { context: 200000, output: 32000 },
    }
  }
  return models
}

export default (async ({ config }: PluginInput) => {
  const poolConfig = readConfig()
  writeBootstrap(poolConfig)
  void ensureDaemon(poolConfig.port)
  config.provider = config.provider ?? {}
  config.provider.keypool = {
    npm: "@ai-sdk/openai-compatible",
    name: "Keypool (rotated keys + provider failover)",
    options: {
      baseURL: `http://127.0.0.1:${poolConfig.port}/v1`,
      apiKey: "keypool",
      timeout: false,
    },
    models: poolModels(poolConfig),
  }
  return {}
}) as KeypoolPlugin
