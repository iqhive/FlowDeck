import type { Plugin } from "@opencode/plugin"
import { z } from "zod"

/**
 * Local replacement for the OpenCode V1 `tool()` helper. FlowDeck tools keep
 * their V1 shape (Zod `args`, `execute(args, context)` returning a string) and
 * `toPluginTool` adapts them to the V2 `ctx.tool.transform` editor.
 */
export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void
  ask(input: unknown): Promise<void>
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: Record<string, unknown>
    }

export type ToolDefinition<Args extends z.ZodRawShape = z.ZodRawShape> = {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}

export function tool<Args extends z.ZodRawShape>(input: ToolDefinition<Args>): ToolDefinition<Args> {
  return input
}
tool.schema = z

type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
export type PluginToolInfo = Parameters<ToolEditor["add"]>[0]

export function toPluginTool(
  name: string,
  def: ToolDefinition,
  location: { directory: string; worktree: string },
): PluginToolInfo {
  const input = z.object(def.args)
  return {
    name,
    description: def.description,
    input,
    async execute(args: z.infer<typeof input>, context) {
      const result = await def.execute(args, {
        sessionID: context.sessionID,
        messageID: context.messageID,
        agent: context.agent,
        directory: location.directory,
        worktree: location.worktree,
        abort: new AbortController().signal,
        metadata: (meta) => {
          if (meta.metadata) void context.progress(meta.metadata)
        },
        ask: async () => {},
      })
      if (typeof result === "string") return { content: result }
      return { content: result.output, ...(result.metadata ? { metadata: result.metadata } : {}) }
    },
  }
}
