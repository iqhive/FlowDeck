import { Model, Plugin, Skill } from "@opencode/plugin"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "fs"
import { basename, dirname, join } from "path"
import { fileURLToPath } from "url"

import {
  buildSelectionDiagnostics,
  detectProjectLanguages,
  getStartupRulePaths,
  selectRulePaths,
} from "./services/lazy-rule-loader"
import { LoopDetector } from "./services/loop-detector"

import { getAgentConfigs } from "./agents/index"
import { loadFlowDeckConfig, resolveAgentModels } from "./config/index"
import { sessionStartHook } from "./hooks/session-start"
import { sessionEventsHook } from "./hooks/session-events"
import { toolGuardHook } from "./hooks/tool-guard"
import { buildFlowDeckMcpsWithMeta } from "./mcp/index"
import { toPluginTool, type ToolDefinition } from "./tool-definition"
import { captureLessonTool, reviewLessonsTool } from "./tools/capture-lesson"
import { codebaseStateTool } from "./tools/codebase-state"
import { fdxValidateTool } from "./tools/fdx-validate"
import { fdxWorktreeTool } from "./tools/fdx-worktree"
import {
  fdxBatchTool,
  fdxContextTool,
  fdxDecisionsTool,
  fdxDiffTool,
  fdxGitTool,
  fdxGraphTool,
  fdxGrepTool,
  fdxImpactTool,
  fdxLintTool,
  fdxLsTool,
  fdxOutlineTool,
  fdxReadTool,
  fdxSearchTool,
  fdxTestTool,
  fdxTreeTool,
} from "./tools/fdx"
import { hashEditTool } from "./tools/hash-edit"
import { loadRulesTool, listRulesTool } from "./tools/load-rules"
import { planningStateTool } from "./tools/planning-state"
import { repoMemoryTool } from "./tools/repo-memory"

const __dir = dirname(fileURLToPath(import.meta.url))

const TOOLS: Record<string, ToolDefinition> = {
  "planning-state": planningStateTool,
  "codebase-state": codebaseStateTool,
  "repo-memory": repoMemoryTool,
  "hash-edit": hashEditTool,
  "load-rules": loadRulesTool,
  "list-rules": listRulesTool,
  "capture-lesson": captureLessonTool,
  "review-lessons": reviewLessonsTool,
  "fdx-context": fdxContextTool,
  "fdx-decisions": fdxDecisionsTool,
  "fdx-validate": fdxValidateTool,
  "fdx-worktree": fdxWorktreeTool,
  "fdx-read": fdxReadTool,
  "fdx-search": fdxSearchTool,
  "fdx-grep": fdxGrepTool,
  "fdx-batch": fdxBatchTool,
  "fdx-graph": fdxGraphTool,
  "fdx-impact": fdxImpactTool,
  "fdx-outline": fdxOutlineTool,
  "fdx-diff": fdxDiffTool,
  "fdx-git": fdxGitTool,
  "fdx-ls": fdxLsTool,
  "fdx-tree": fdxTreeTool,
  "fdx-test": fdxTestTool,
  "fdx-lint": fdxLintTool,
}

/** Select FlowDeck rule paths injected as system context. */
function lazyLoadRulePaths(projectRoot: string): { paths: string[]; diagnostics: string } {
  const rulesDir = join(__dir, "..", "src", "rules")
  if (!existsSync(rulesDir)) return { paths: [], diagnostics: "[LazyRuleLoader] rules directory not found" }
  const detected = detectProjectLanguages(projectRoot)
  const paths = getStartupRulePaths(rulesDir, detected)
  const selection = selectRulePaths(rulesDir, { languages: detected, projectRoot })
  return { paths, diagnostics: buildSelectionDiagnostics(selection, { languages: detected, projectRoot }) }
}

/** Split a Markdown file into its YAML frontmatter block and body. */
function parseMarkdown(raw: string): { frontmatter: string; body: string } {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  return fm ? { frontmatter: fm[1], body: fm[2].trim() } : { frontmatter: "", body: raw }
}

function frontmatterField(frontmatter: string, key: string): string | undefined {
  return frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim()
}

/** Load FlowDeck slash commands from src/commands/*.md (parses frontmatter description). */
function loadCommands(): Record<string, { description?: string; template: string }> {
  const dir = join(__dir, "..", "src", "commands")
  if (!existsSync(dir)) return {}
  const out: Record<string, { description?: string; template: string }> = {}
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue
      const { frontmatter, body } = parseMarkdown(readFileSync(join(dir, file), "utf-8"))
      const desc = frontmatterField(frontmatter, "description")
      out[basename(file, ".md")] = desc ? { description: desc, template: body } : { template: body }
    }
  } catch { /* ignore */ }
  return out
}

/** Load FlowDeck skills from src/skills/<name>/SKILL.md. */
function loadSkills(): Skill.Info[] {
  const dir = join(__dir, "..", "src", "skills")
  if (!existsSync(dir)) return []
  const out: Skill.Info[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry, "SKILL.md")
      if (!existsSync(path)) continue
      const { frontmatter, body } = parseMarkdown(readFileSync(path, "utf-8"))
      const description = frontmatterField(frontmatter, "description")
      out.push(
        Skill.Info.make({
          id: Skill.ID.make(entry),
          name: Skill.Name.make(frontmatterField(frontmatter, "name") ?? entry),
          ...(description ? { description } : {}),
          path: Skill.Info.fields.path.make(path),
          content: body,
        }),
      )
    }
  } catch { /* ignore */ }
  return out
}

/** Expand `$ARGUMENTS` and positional `$1..$N` placeholders the way OpenCode's config commands do. */
function expandTemplate(template: string, input: string): string {
  const args = input.trim() ? input.trim().split(/\s+/) : []
  const placeholderRegex = /\$(\d+)/g
  const placeholders = template.match(placeholderRegex) ?? []
  const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
  const expanded = template.replaceAll(placeholderRegex, (_, index: string) => {
    const position = Number(index)
    const argIndex = position - 1
    if (argIndex >= args.length) return ""
    if (position === last) return args.slice(argIndex).join(" ")
    return args[argIndex]
  })
  const withArguments = expanded.replaceAll("$ARGUMENTS", () => input)
  return placeholders.length === 0 && !template.includes("$ARGUMENTS") && input.trim()
    ? `${withArguments}\n\n${input}`.trim()
    : withArguments.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export default Plugin.define({
  id: "flowdeck",
  async setup(ctx) {
    const directory = ctx.location.directory

    // Log file only, no stdout: the plugin shares a process with the OpenCode UI.
    const appLog = (msg: string): void => {
      try {
        const logDir = join(directory, ".opencode")
        if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
        const entry = { timestamp: new Date().toISOString(), event: "log", detail: msg }
        appendFileSync(join(logDir, "flowdeck.log"), JSON.stringify(entry) + "\n", "utf-8")
      } catch { /* best-effort */ }
    }

    const flowdeckConfig = loadFlowDeckConfig(directory)
    const loopDetector = new LoopDetector(flowdeckConfig.governance?.loopDetection, appLog)

    // Agents: FlowDeck defaults. User `agents` config is applied by OpenCode after plugin
    // transforms, so user overrides (including `default_agent`) still win.
    await ctx.agent.transform((editor) => {
      editor.default("orchestrator")
      const resolved = getAgentConfigs(resolveAgentModels(flowdeckConfig))
      for (const [name, def] of Object.entries(resolved)) {
        editor.update(name, (agent) => {
          if (def.model?.includes("/")) agent.model = Model.Ref.parse(def.model)
          if (def.prompt !== undefined) agent.system = def.prompt
          if (def.description !== undefined) agent.description = def.description
          if (def.mode !== undefined) agent.mode = def.mode
          if (def.hidden !== undefined) agent.hidden = def.hidden
          if (def.temperature !== undefined) agent.request.body.temperature = def.temperature
        })
      }
    })

    await ctx.mcp.transform((editor) => {
      for (const [name, mcp] of Object.entries(buildFlowDeckMcpsWithMeta().mcps)) {
        const { enabled, ...rest } = mcp
        editor.set(name, { ...rest, disabled: !enabled })
      }
    })

    await ctx.command.transform((editor) => {
      for (const [name, cmd] of Object.entries(loadCommands())) {
        editor.add({
          name,
          description: cmd.description,
          execute: async (input) => {
            await ctx.session.prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text: expandTemplate(cmd.template, input.prompt.text),
              delivery: input.delivery,
            })
          },
        })
      }
    })

    await ctx.skill.transform((editor) => {
      for (const skill of loadSkills()) editor.add(skill)
    })

    await ctx.tool.transform((editor) => {
      const location = { directory, worktree: ctx.location.project.directory }
      for (const [name, def] of Object.entries(TOOLS)) editor.add(toPluginTool(name, def, location))
    })

    // Language-specific rules: V1 appended file paths to `instructions`; V2 injects the
    // file contents into the system prompt of every agent-loop request.
    const { paths: rulePaths, diagnostics } = lazyLoadRulePaths(directory)
    appLog(diagnostics)
    const rules = rulePaths.flatMap((p) => {
      try {
        return [`# Rules from ${p}\n\n${readFileSync(p, "utf-8")}`]
      } catch {
        return []
      }
    })
    if (rules.length > 0) {
      await ctx.session.hook("context", (event) => {
        for (const text of rules) event.system.push({ type: "text", text })
      })
    }

    // Tool guard (FLOWDECK_TOOL_GUARD_ENABLED=on) — blocks dangerous ops, enforces
    // architectural constraints and per-agent write limits. Throwing rejects the call.
    await ctx.tool.hook("execute.before", async (event) => {
      const args = isRecord(event.input) ? event.input : {}
      await toolGuardHook({ directory, agent: event.agent }, { tool: event.tool, sessionID: event.sessionID }, { args })
      const loop = loopDetector.checkBefore(event.tool, args, event.sessionID)
      if (loop.action === "block") throw new Error(loop.escalationMessage)
      if (loop.action === "warn") appLog(loop.message)
    })

    await ctx.tool.hook("execute.after", (event) => {
      appLog(`[tool] done tool=${event.tool} session=${event.sessionID}`)
      loopDetector.recordAfter(
        event.tool,
        isRecord(event.input) ? event.input : {},
        event.status === "completed" ? event.result.content : event.error.message,
        event.sessionID,
        event.status === "completed" ? "success" : "error",
      )
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (event.type === "session.created") {
            await sessionStartHook({ directory }, appLog)
          } else if (event.type === "session.idle") {
            await sessionEventsHook({ directory }, "idle", event.data.sessionID)
          } else if (event.type === "session.execution.failed") {
            await sessionEventsHook({ directory }, "error", event.data.sessionID)
          }
        } catch (err) {
          appLog(`[event] ${event.type} handler failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })().catch((err: unknown) => appLog(`[event] subscription ended: ${err instanceof Error ? err.message : String(err)}`))

    return () => controller.abort()
  },
})
