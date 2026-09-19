/**
 * Plugin Entry Integration Tests
 *
 * Covers:
 * - `setup()` registers agents, MCPs, commands, skills, tools and hooks via the V2 context.
 * - Surviving tool registrations are present.
 * - tool `execute.before` calls guard-rails + loop detector (no longer attaches routing hints).
 * - event subscription calls sessionStartHook on session.created.
 * - Removed tools are not registered.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { planningDir } from "@/tools/planning-state-lib"
import plugin from "@/index"
import { setupPlugin } from "./helpers/plugin-context"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "flowdeck-index-test-"))
}

function writeState(dir: string): void {
  const pd = planningDir(dir)
  mkdirSync(pd, { recursive: true })
  writeFileSync(join(pd, "STATE.md"), "---\nphase: 1\n---\n# State", "utf-8")
}

function readLog(dir: string): string {
  const logPath = join(dir, ".opencode", "flowdeck.log")
  return existsSync(logPath) ? readFileSync(logPath, "utf-8") : ""
}

const toolEvent = (tool: string, input: unknown, sessionID = "sess-1", agent = "backend-coder") => ({
  tool,
  sessionID,
  agent,
  messageID: "msg-1",
  id: "call-1",
  input,
})
const beforeEvent = (tool: string, input: unknown, sessionID = "sess-1", agent = "backend-coder") =>
  toolEvent(tool, input, sessionID, agent) as never

describe("plugin entry", () => {
  let dir: string

  beforeEach(() => {
    dir = makeTempDir()
    writeState(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(planningDir(dir), { recursive: true, force: true })
  })

  it("is a V2 plugin definition with the flowdeck id", () => {
    expect(plugin.id).toBe("flowdeck")
    expect(typeof plugin.setup).toBe("function")
  })

  it("registers agents, MCPs, commands, skills, tools and hooks", async () => {
    const instance = await setupPlugin(dir)

    expect(instance.defaultAgent).toBe("orchestrator")
    expect(instance.agents.has("orchestrator")).toBe(true)
    expect(instance.agents.get("orchestrator")?.mode).toBe("primary")
    expect(instance.mcps.size).toBeGreaterThan(0)
    for (const cfg of instance.mcps.values()) expect(typeof cfg.disabled).toBe("boolean")
    expect(instance.commands.has("fd-task")).toBe(true)
    expect(instance.commands.get("fd-task")?.description).toBeTruthy()
    expect(instance.skills.size).toBeGreaterThan(0)
    for (const skill of instance.skills.values()) expect(skill.path.endsWith("SKILL.md")).toBe(true)
    expect(instance.toolHooks.before).toHaveLength(1)
    expect(instance.toolHooks.after).toHaveLength(1)
    await instance.cleanup()
  })

  it("registers the surviving core tools", async () => {
    const instance = await setupPlugin(dir)

    const toolNames = [...instance.tools.keys()]
    const expected = [
      "planning-state",
      "codebase-state",
      "repo-memory",
      "hash-edit",
      "load-rules",
      "list-rules",
      "capture-lesson",
      "review-lessons",
      // Without this, deleting the fdx-graph registration would break no test,
      // which is how the tool stayed unreachable for four of its actions.
      "fdx-graph",
    ]
    for (const name of expected) {
      expect(toolNames).toContain(name)
    }
    await instance.cleanup()
  })

  it("does not register removed tools", async () => {
    const instance = await setupPlugin(dir)

    const toolNames = [...instance.tools.keys()]
    expect(toolNames).not.toContain("delegate")
    expect(toolNames).not.toContain("run-pipeline")
    expect(toolNames).not.toContain("council")
    expect(toolNames).not.toContain("decision-trace")
    expect(toolNames).not.toContain("reflect")
    await instance.cleanup()
  })

  it("expands $ARGUMENTS in command templates and prompts the session", async () => {
    const instance = await setupPlugin(dir)

    await instance.commands.get("fd-task")!.execute({
      sessionID: "sess-1",
      prompt: { text: "add caching" },
      delivery: "steer",
    } as never)

    expect(instance.prompts).toHaveLength(1)
    const sent = instance.prompts[0] as { sessionID: string; text: string; delivery: string }
    expect(sent.sessionID).toBe("sess-1")
    expect(sent.delivery).toBe("steer")
    expect(sent.text).toContain("add caching")
    expect(sent.text).not.toContain("$ARGUMENTS")
    await instance.cleanup()
  })

  it("calls sessionStartHook on session.created events", async () => {
    const instance = await setupPlugin(dir)

    let threw: unknown = null
    try {
      await instance.emit({ type: "session.created", data: { info: { id: "sess-1" } } })
    } catch (err) {
      threw = err
    }
    expect(threw).toBeNull()
    await instance.cleanup()
  })

  it("emits a minimal completion log from execute.after", async () => {
    const instance = await setupPlugin(dir)

    await instance.runAfter({
      ...toolEvent("read", { filePath: "x.ts" }),
      status: "completed",
      result: { content: "ok" },
    })

    const doneLog = readLog(dir)
      .split("\n")
      .find((line) => line.includes("[tool] done"))
    expect(doneLog).toBeDefined()
    expect(doneLog).toMatch(/tool=read/)
    expect(doneLog).toMatch(/session=sess-1/)
    await instance.cleanup()
  })

  it("does not attach a flowdeck routing hint in execute.before", async () => {
    const instance = await setupPlugin(dir)

    const event: { metadata?: { flowdeckRouting?: unknown } } = beforeEvent("read", { filePath: "x.ts" })
    let threw: unknown = null
    try {
      await instance.runBefore(event as never)
    } catch (err) {
      threw = err
    }
    expect(threw).toBeNull()
    expect(event.metadata?.flowdeckRouting).toBeUndefined()
    await instance.cleanup()
  })
})

/**
 * Regression: sessionEventsHook and toolGuardHook must be wired into the
 * plugin's hook surface. Without these wires, the write-limit counter
 * never resets between sessions (clearWriteCounter is never called) and
 * FLOWDECK_TOOL_GUARD_ENABLED=on has no effect.
 *
 * Strategy: drive the hooks with controlled inputs and assert observable
 * side effects (log entries, write counter state).
 */
describe("plugin entry: sessionEventsHook wiring (bug 3a)", () => {
  let dir: string

  beforeEach(() => {
    dir = makeTempDir()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(planningDir(dir), { recursive: true, force: true })
  })

  it("writes a flowdeck.log entry on session.idle events", async () => {
    const instance = await setupPlugin(dir)

    await instance.emit({ type: "session.idle", data: { sessionID: "sess-idle" } })

    expect(readLog(dir)).toContain('"event":"idle"')
    await instance.cleanup()
  })

  it("writes a flowdeck.log entry on session.execution.failed events", async () => {
    const instance = await setupPlugin(dir)

    await instance.emit({ type: "session.execution.failed", data: { sessionID: "sess-err", error: {} } })

    expect(readLog(dir)).toContain('"event":"error"')
    await instance.cleanup()
  })

  it("session.idle clears the per-session write counter", async () => {
    const { recordWrite, getWriteCount, clearWriteCounter } = await import("@/hooks/tool-guard")
    const instance = await setupPlugin(dir)

    const sessionID = "sess-clear"
    recordWrite(sessionID, "/tmp/a.ts")
    recordWrite(sessionID, "/tmp/b.ts")
    expect(getWriteCount(sessionID)).toBe(2)

    await instance.emit({ type: "session.idle", data: { sessionID } })

    expect(getWriteCount(sessionID)).toBe(0)
    clearWriteCounter(sessionID)
    await instance.cleanup()
  })

  it("cleanup stops the event subscription", async () => {
    const instance = await setupPlugin(dir)
    await instance.cleanup()

    // After abort, the subscribe loop has exited; nothing consumes emitted events.
    const raced = await Promise.race([
      instance.emit({ type: "session.idle", data: { sessionID: "after-cleanup" } }).then(() => "consumed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("ignored"), 50)),
    ])
    expect(raced).toBe("ignored")
    expect(readLog(dir)).not.toContain('"event":"idle"')
  })
})

describe("plugin entry: toolGuardHook wiring (bug 3b)", () => {
  let dir: string
  let prevEnv: string | undefined

  beforeEach(() => {
    dir = makeTempDir()
    prevEnv = process.env.FLOWDECK_TOOL_GUARD_ENABLED
    process.env.FLOWDECK_TOOL_GUARD_ENABLED = "on"
    process.env.FLOWDECK_GUARD_RAILS_ENABLED = "off"
    // Provide a STATE.md so phase enforcement has something to read.
    mkdirSync(planningDir(dir), { recursive: true })
    writeFileSync(join(planningDir(dir), "STATE.md"), "phase: 1\nstatus: planned")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(planningDir(dir), { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.FLOWDECK_TOOL_GUARD_ENABLED
    else process.env.FLOWDECK_TOOL_GUARD_ENABLED = prevEnv
    delete process.env.FLOWDECK_GUARD_RAILS_ENABLED
  })

  it("blocks a write in discuss phase when FLOWDECK_TOOL_GUARD_ENABLED=on", async () => {
    const instance = await setupPlugin(dir)

    let caught: Error | null = null
    try {
      await instance.runBefore(beforeEvent("write", { filePath: "src/x.ts" }, "primary"))
    } catch (err) {
      caught = err as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toMatch(/blocked in phase 1/)
    await instance.cleanup()
  })

  it("enforces the agent contract using the V2 event agent", async () => {
    const instance = await setupPlugin(dir)

    let caught: Error | null = null
    try {
      await instance.runBefore(beforeEvent("write", { filePath: "src/x.ts" }, "primary", "orchestrator"))
    } catch (err) {
      caught = err as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toMatch(/tool-not-in-contract/)
    await instance.cleanup()
  })
})
