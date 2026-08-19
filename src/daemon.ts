import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Health } from "./tui.ts"
import { ensureDirs, LOG_PATH, PID_PATH } from "./config.ts"

export const DAEMON_URL = (port: number) => `http://127.0.0.1:${port}`

export async function health(port: number, timeoutMs = 800): Promise<Health | null> {
  try {
    const response = await fetch(`${DAEMON_URL(port)}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    return (await response.json()) as Health
  } catch {
    return null
  }
}

export function findBun(): string | null {
  const fromPath = Bun.which("bun")
  if (fromPath) return fromPath
  const install = process.env.BUN_INSTALL
  if (install) {
    const candidate = join(install, "bin", "bun")
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function daemonPid(): number | null {
  try {
    const pid = Number(readFileSync(PID_PATH, "utf8").trim())
    if (!Number.isFinite(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

export function cliPath(): string {
  return new URL("./cli.ts", import.meta.url).pathname
}

export async function waitForHealth(port: number, timeoutMs = 6000): Promise<Health | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const h = await health(port, 200)
    if (h) return h
    await Bun.sleep(150)
  }
  return health(port, 500)
}

export async function spawnDaemonAsync(port?: number): Promise<number> {
  ensureDirs()
  const existing = daemonPid()
  if (existing) {
    console.log(`route daemon already running (pid ${existing}).`)
    process.exit(0)
  }
  if (port && (await health(port, 400))) {
    console.error(`something already serves 127.0.0.1:${port}. Stop it (or "kill $(lsof -ti tcp:${port})") and retry.`)
    process.exit(1)
  }
  return spawnDaemon(port)
}

export function spawnDaemon(port?: number): number {
  ensureDirs()
  const bun = findBun()
  if (!bun) {
    console.error("bun was not found on PATH. Install bun (https://bun.sh) or run the daemon inside a bun process.")
    process.exit(1)
  }
  const existing = daemonPid()
  if (existing) {
    console.log(`route daemon already running (pid ${existing}).`)
    process.exit(0)
  }
  const logFd = openSync(LOG_PATH, "a")
  const args = [cliPath(), "serve"]
  if (port) args.push("--port", String(port))
  const proc = Bun.spawn([bun, ...args], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  })
  proc.unref()
  writeFileSync(PID_PATH, String(proc.pid), { mode: 0o600 })
  console.log(`route daemon started (pid ${proc.pid}), log: ${LOG_PATH}`)
  return proc.pid
}

export function stopDaemon(): boolean {
  const pid = daemonPid()
  if (!pid) {
    console.log("route daemon is not running.")
    return false
  }
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    try {
      unlinkSync(PID_PATH)
    } catch {
      //
    }
    return false
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      Bun.sleepSync(100)
    } catch {
      try {
        unlinkSync(PID_PATH)
      } catch {
        //
      }
      console.log(`route daemon stopped (pid ${pid}).`)
      return true
    }
  }
  console.error(`daemon pid ${pid} did not exit after SIGTERM; try "kill -9 ${pid}"`)
  return false
}
