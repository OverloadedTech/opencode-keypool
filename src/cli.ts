#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { PoolConfig } from "./config.ts"
import { CONFIG_PATH, loadConfig, saveConfig } from "./config.ts"
import { daemonPid, findBun, health, spawnDaemon, spawnDaemonAsync, stopDaemon, waitForHealth } from "./daemon.ts"
import { serve } from "./server.ts"

const HELP = `oc-route — per-entry IP/proxy rotation and never-stop failover for opencode

Usage: oc-route <command> [options]

Commands:
  tui                 configure pools, proxies and providers in a TUI (default)
  serve [--port N]    run the rotation proxy in the foreground
  start [--port N]    start the rotation proxy as a background daemon
  stop                stop the background daemon
  restart [--port N]  restart the daemon
  status              show daemon health and pool configuration
  health              print the raw /health JSON from the daemon
  install [--self]    register the opencode plugin in the global opencode config
                      (--self registers this checkout's plugin file directly)
  uninstall           remove the plugin entry from the global opencode config
  doctor              diagnose the installation (bun, daemon, opencode config)
  list                print pools and entries (API keys redacted)
  version             print the version

Global options:
  --config <path>     use an alternative config file
  --help              show this help
`

function configPathFromArgs(args: string[]): string {
  const idx = args.indexOf("--config")
  if (idx >= 0) {
    const value = args[idx + 1]
    if (value) return value
  }
  return CONFIG_PATH
}

function portFromArgs(args: string[]): number | undefined {
  const idx = args.indexOf("--port")
  if (idx >= 0 && args[idx + 1]) {
    const port = Number(args[idx + 1])
    if (Number.isFinite(port)) return port
  }
  return undefined
}

function opencodeGlobalConfig(): string {
  const base = process.env.XDG_CONFIG_HOME || join(process.env.HOME || "/", ".config")
  const dir = join(base, "opencode")
  const jsonc = join(dir, "opencode.jsonc")
  if (existsSync(jsonc)) return jsonc
  return join(dir, "opencode.json")
}

function stripJsoncComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"])[/][/].*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1")
}

function readOpencodeConfig(path: string): { config: Record<string, unknown> | null; raw: string } {
  if (!existsSync(path)) return { config: null, raw: "" }
  const raw = readFileSync(path, "utf8")
  try {
    return { config: JSON.parse(stripJsoncComments(raw)), raw }
  } catch {
    return { config: null, raw }
  }
}

export function installPlugin(self: boolean, configPath: string = opencodeGlobalConfig()): void {
  const target = self ? new URL("./plugin.ts", import.meta.url).pathname : "opencode-route"
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  const { config } = readOpencodeConfig(configPath)
  const next = config ?? {}
  const plugins = Array.isArray(next.plugin) ? (next.plugin as unknown[]) : []
  const present = plugins.some((entry) => {
    if (typeof entry === "string") return entry === target
    if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0] === target
    return false
  })
  if (!present) {
    plugins.push(target)
    next.plugin = plugins
  }
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
  console.log(`Registered plugin entry "${target}" in ${configPath}`)
  console.log("Restart opencode to load the plugin. Then pick a route model with /models or in Settings.")
}

function isRoutePlugin(value: unknown): boolean {
  if (typeof value !== "string") return false
  return (
    value === "opencode-route" ||
    value === "oc-keypool" ||
    value.endsWith("opencode-route/src/plugin.ts") ||
    value.endsWith("opencode-keypool/src/plugin.ts")
  )
}

export function uninstallPlugin(configPath: string = opencodeGlobalConfig()): void {
  const { config, raw } = readOpencodeConfig(configPath)
  if (!config) {
    console.log("No opencode config found.")
    return
  }
  const plugins = Array.isArray(config.plugin) ? (config.plugin as unknown[]) : []
  const filtered = plugins.filter((entry) => {
    if (typeof entry === "string") return !isRoutePlugin(entry)
    if (Array.isArray(entry)) return !isRoutePlugin(entry[0])
    return true
  })
  config.plugin = filtered
  if (filtered.length === 0) delete config.plugin
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
  if (raw !== JSON.stringify(config, null, 2)) {
    console.log(`Removed opencode-route from ${configPath}. Restart opencode to apply.`)
  } else {
    console.log("opencode-route was not registered.")
  }
}

async function printStatus(config: PoolConfig): Promise<void> {
  const h = await health(config.port, 1000)
  if (h) {
    console.log(`daemon: up (127.0.0.1:${h.port ?? config.port}, uptime ${h.uptime_seconds ?? 0}s)`)
    const breaker = h.breaker
    if (breaker?.active) console.log(`circuit breaker: OPEN (${breaker.remaining}s) — ${breaker.reason}`)
    const stats = h.stats
    if (stats) {
      console.log(`requests ${stats.requests} · failovers ${stats.failovers} · rate limits ${stats.rate_limits} · auth failures ${stats.auth_failures} · upstream errors ${stats.upstream_errors}`)
    }
    if (h.entries && h.entries.length > 0) {
      console.log("")
      console.log("entries:")
      for (const entry of h.entries) {
        const stateText = !entry.enabled
          ? "disabled"
          : entry.cooldown > 0
            ? `cooldown ${entry.cooldown}s`
            : entry.last_error
              ? `error: ${entry.last_error}`
              : "ok"
        console.log(`  [${entry.pool}] ${entry.label} — ${entry.adapter}/${entry.model} — ${stateText} — ${entry.successes} ok`)
      }
    }
  } else {
    console.log("daemon: down")
  }
  console.log("")
  console.log("pools:")
  for (const pool of config.pools) {
    console.log(`  ${pool.id} "${pool.label}" (${pool.entries.length} entries)`)
    for (const entry of pool.entries) {
      const key = entry.api_key ? `key ${redactKey(entry.api_key)}` : "no key"
      console.log(`    ${entry.enabled ? "on " : "off"} ${entry.adapter.padEnd(9)} ${entry.model.padEnd(28)} ${entry.base_url || "(no base url)"}  ${key}`)
    }
  }
}

function redactKey(key: string): string {
  if (key.length <= 8) return "****"
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP)
    return
  }
  const command = args[0] ?? "tui"
  const rest = args.slice(1)
  const configPath = configPathFromArgs(rest)
  if (command === "version") {
    console.log("opencode-route 0.1.0")
    return
  }
  if (command === "serve") {
    const port = portFromArgs(rest)
    const server = serve(configPath, port)
    console.log(`route daemon listening on ${server.url}`)
    const stop = () => {
      void server.stop().finally(() => process.exit(0))
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    await new Promise(() => {})
    return
  }
  if (command === "start") {
    const config = loadConfig(configPath)
    await spawnDaemonAsync(portFromArgs(rest) ?? config.port)
    if (rest.includes("--wait")) {
      const h = await waitForHealth(config.port)
      console.log(h ? "daemon is healthy" : "daemon did not become healthy in time")
    }
    return
  }
  if (command === "stop") {
    stopDaemon()
    return
  }
  if (command === "restart") {
    stopDaemon()
    Bun.sleepSync(300)
    const config = loadConfig(configPath)
    spawnDaemon(portFromArgs(rest) ?? config.port)
    return
  }
  if (command === "health") {
    const config = loadConfig(configPath)
    const h = await health(config.port, 1500)
    console.log(h ? JSON.stringify(h, null, 2) : `no daemon on 127.0.0.1:${config.port}`)
    return
  }
  if (command === "status") {
    const config = loadConfig(configPath)
    await printStatus(config)
    return
  }
  if (command === "install") {
    installPlugin(rest.includes("--self"))
    return
  }
  if (command === "uninstall") {
    uninstallPlugin()
    return
  }
  if (command === "doctor") {
    const config = loadConfig(configPath)
    console.log(`bun: ${findBun() ?? "NOT FOUND (install from https://bun.sh)"}`)
    console.log(`config: ${configPath} (${config.pools.length} pools)`)
    const pid = daemonPid()
    console.log(`daemon: ${pid ? `running (pid ${pid})` : "not running"}`)
    const h = await health(config.port, 1500)
    console.log(`health: ${h ? "ok" : "unreachable"}`)
    const { config: oc } = readOpencodeConfig(opencodeGlobalConfig())
    const plugins = Array.isArray(oc?.plugin) ? (oc.plugin as unknown[]) : []
    const registered = plugins.some((entry) => {
      const value = Array.isArray(entry) ? entry[0] : entry
      return isRoutePlugin(value)
    })
    console.log(`opencode plugin: ${registered ? "registered" : "NOT registered (run oc-route install)"}`)
    return
  }
  if (command === "list") {
    const config = loadConfig(configPath)
    for (const pool of config.pools) {
      console.log(`${pool.id}\t"${pool.label}"`)
      for (const entry of pool.entries) {
        console.log(`  ${entry.enabled ? "on " : "off"} ${entry.id}\t${entry.adapter}\t${entry.model}\t${entry.base_url || "-"}`)
      }
    }
    return
  }
  if (command === "tui") {
    const config = loadConfig(configPath)
    const { runTui } = await import("./tui.ts")
    await runTui(
      config,
      (next) => saveConfig(next, configPath),
      () => health(loadConfig(configPath).port, 600),
      {
        isTTY: Boolean(process.stdin.isTTY),
        write: (text) => process.stdout.write(`\x1b[H${text}\x1b[J`),
        readKey: readKeyRaw,
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
        onResize: (cb) => process.stdout.on("resize", cb),
      },
    )
    console.log()
    return
  }
  console.log(HELP)
}

let keyQueue: string[] = []

function readKeyRaw(): Promise<string> {
  const queued = keyQueue.shift()
  if (queued !== undefined) return Promise.resolve(queued)
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const keys = chunk.toString()
      if (keys.startsWith("\x1b") && keys.length === 1) {
        let settled = false
        const onMore = (more: Buffer) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const rest = keys + more.toString()
          process.stdin.off("data", onData)
          keyQueue.push(...rest.slice(1))
          resolve(rest[0] ?? "\x1b")
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          process.stdin.off("data", onMore)
          process.stdin.off("data", onData)
          resolve("\x1b")
        }, 40)
        process.stdin.once("data", onMore)
        return
      }
      process.stdin.off("data", onData)
      keyQueue.push(...keys.slice(1))
      resolve(keys[0] ?? "")
    }
    process.stdin.on("data", onData)
  })
}

void main()
