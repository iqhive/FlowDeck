/**
 * Minimal in-memory stand-in for the OpenCode V2 `Plugin.Context`.
 *
 * Records every registration FlowDeck's `setup()` performs (agents, MCPs,
 * commands, skills, tools, hooks) and exposes `emit()` to feed events into
 * the plugin's `ctx.event.subscribe()` loop.
 */

import type { Plugin } from "@opencode/plugin"
import { Agent } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { CommandDefinition, CommandEditor } from "@opencode/plugin/promise/command"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import type { SkillEditor } from "@opencode/plugin/promise/skill"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import type { Mcp } from "@opencode/schema/mcp"
import type { Skill } from "@opencode/schema/skill"
import type { DeepMutable } from "@opencode/plugin/promise/types"
import plugin from "@/index"

type AgentInfo = Parameters<Parameters<AgentEditor["update"]>[1]>[0]
type ToolInfo = ReturnType<ToolEditor["list"]>[number]
type ToolHook = Plugin.Context["tool"]["hook"]
type ToolBeforeEvent = Parameters<Parameters<ToolHook>[1]>[0]
type SessionHook = Plugin.Context["session"]["hook"]
type SessionHookEvent = Parameters<Parameters<SessionHook>[1]>[0]
type HookCallback = (event: never) => Promise<void> | void

export interface RecordedContext {
  ctx: Plugin.Context
  agents: Map<string, AgentInfo>
  defaultAgent: string | undefined
  mcps: Map<string, Mcp.ServerConfig>
  commands: Map<string, CommandDefinition>
  skills: Map<string, Skill.Info>
  tools: Map<string, ToolInfo>
  toolHooks: { before: HookCallback[]; after: HookCallback[] }
  sessionHooks: Map<string, HookCallback[]>
  prompts: unknown[]
  /** Push an event into the subscribe() stream and wait until handlers finish. */
  emit(event: unknown): Promise<void>
  /** Invoke every registered `execute.before` hook with the given event. */
  runBefore(event: ToolBeforeEvent): Promise<void>
  /** Invoke every registered `execute.after` hook with the given event. */
  runAfter(event: unknown): Promise<void>
  /** Invoke every registered session hook of the given name. */
  runSessionHook(name: string, event: SessionHookEvent): Promise<void>
}

function registration() {
  return Promise.resolve({ dispose: async () => {} })
}

function defaultAgent(id: string): AgentInfo {
  return {
    id: Agent.ID.make(id),
    name: Agent.Name.make(id),
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [],
  }
}

export function createRecordedContext(directory: string): RecordedContext {
  const agents = new Map<string, AgentInfo>()
  const mcps = new Map<string, Mcp.ServerConfig>()
  const commands = new Map<string, CommandDefinition>()
  const skills = new Map<string, Skill.Info>()
  const tools = new Map<string, ToolInfo>()
  const toolHooks = { before: [] as HookCallback[], after: [] as HookCallback[] }
  const sessionHooks = new Map<string, HookCallback[]>()
  const prompts: unknown[] = []
  const state: { defaultAgent: string | undefined } = { defaultAgent: undefined }

  // Event stream: emit() enqueues and resolves once the consumer asks for the next event.
  const queue: Array<{ event: unknown; done: () => void }> = []
  let wake: (() => void) | undefined
  async function* stream(signal?: AbortSignal) {
    let pending: (() => void) | undefined
    while (!signal?.aborted) {
      pending?.()
      pending = undefined
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
          signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        continue
      }
      const next = queue.shift()!
      pending = next.done
      yield next.event
    }
    pending?.()
  }

  const agentEditor: AgentEditor = {
    list: () => [...agents.values()],
    get: (id) => agents.get(id),
    default: (id) => {
      state.defaultAgent = id
    },
    update: (id, fn) => {
      const current = agents.get(id) ?? defaultAgent(id)
      agents.set(id, current)
      fn(current)
    },
    remove: (id) => {
      agents.delete(id)
    },
  }

  const mcpEditor: MCPEditor = {
    list: () => [...mcps.entries()].map(([name, cfg]) => [name, cfg as DeepMutable<Mcp.ServerConfig>]),
    get: (name) => mcps.get(name) as DeepMutable<Mcp.ServerConfig> | undefined,
    set: (name, config) => {
      mcps.set(name, config)
    },
    update: (name, fn) => {
      const current = mcps.get(name)
      if (current) fn(current as DeepMutable<Mcp.ServerConfig>)
    },
    remove: (name) => {
      mcps.delete(name)
    },
  }

  const commandEditor: CommandEditor = {
    add: (definition) => {
      commands.set(definition.name, definition)
    },
  }

  const skillEditor: SkillEditor = {
    list: () => [...skills.values()] as DeepMutable<Skill.Info>[],
    get: (id) => skills.get(id) as DeepMutable<Skill.Info> | undefined,
    add: (skill) => {
      skills.set(skill.id, skill)
    },
    update: (id, fn) => {
      const current = skills.get(id)
      if (current) fn(current as DeepMutable<Skill.Info>)
    },
    remove: (id) => {
      skills.delete(id)
    },
  }

  const toolEditor: ToolEditor = {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    namespace: () => {},
    add: (tool) => {
      tools.set(tool.name, { ...tool, id: tool.name } as ToolInfo)
    },
    update: (id, fn) => {
      const current = tools.get(id)
      if (current) fn(current)
    },
    remove: (id) => {
      tools.delete(id)
    },
  }

  const partial = {
    location: { directory, project: { id: "test", directory, canonical: directory } },
    agent: { transform: (fn: (editor: AgentEditor) => void) => (fn(agentEditor), registration()) },
    mcp: { transform: (fn: (editor: MCPEditor) => void) => (fn(mcpEditor), registration()) },
    command: { transform: (fn: (editor: CommandEditor) => void) => (fn(commandEditor), registration()) },
    skill: { transform: (fn: (editor: SkillEditor) => void) => (fn(skillEditor), registration()) },
    tool: {
      transform: (fn: (editor: ToolEditor) => void) => (fn(toolEditor), registration()),
      hook: (name: "execute.before" | "execute.after", cb: HookCallback) => {
        toolHooks[name === "execute.before" ? "before" : "after"].push(cb)
        return registration()
      },
    },
    session: {
      hook: (name: string, cb: HookCallback) => {
        sessionHooks.set(name, [...(sessionHooks.get(name) ?? []), cb])
        return registration()
      },
      prompt: async (input: unknown) => {
        prompts.push(input)
        return {}
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => stream(options?.signal),
    },
  }

  return {
    ctx: partial as unknown as Plugin.Context,
    agents,
    get defaultAgent() {
      return state.defaultAgent
    },
    mcps,
    commands,
    skills,
    tools,
    toolHooks,
    sessionHooks,
    prompts,
    emit: (event) =>
      new Promise<void>((done) => {
        queue.push({ event, done })
        wake?.()
        wake = undefined
      }),
    runBefore: async (event) => {
      for (const cb of toolHooks.before) await cb(event as never)
    },
    runAfter: async (event) => {
      for (const cb of toolHooks.after) await cb(event as never)
    },
    runSessionHook: async (name, event) => {
      for (const cb of sessionHooks.get(name) ?? []) await cb(event as never)
    },
  }
}

/** Run FlowDeck's `setup()` against a recorded context for `directory`. */
export async function setupPlugin(directory: string): Promise<RecordedContext & { cleanup: () => Promise<void> }> {
  const recorded = createRecordedContext(directory)
  const cleanup = await plugin.setup(recorded.ctx)
  return {
    ...recorded,
    get defaultAgent() {
      return recorded.defaultAgent
    },
    cleanup: async () => {
      await cleanup?.()
    },
  }
}
