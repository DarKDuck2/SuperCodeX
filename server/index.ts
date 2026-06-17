import cors from "cors";
import "dotenv/config";
import express from "express";
import multer from "multer";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createAgentRuntime } from "./agent/runtime.js";
import { createAutomationRunner } from "./automation/runner.js";
import {
  readPositiveIntegerEnv,
  splitCommandArgs
} from "./core/local-files.js";
import { safeResolvePath } from "./core/paths.js";
import { registerApiRoutes } from "./http/routes.js";
import { createSkillService } from "./skills/service.js";
import { createStateService } from "./state/store.js";
import { registerServerTools } from "./tools/register.js";
import { ToolRegistry } from "./tools/registry.js";
import { createWebBridgeService } from "./webbridge/service.js";
import type {
  AgentEvent,
  AgentRunMode,
  ApiConfig,
  Attachment,
  Automation,
  Conversation,
  Project,
  Skill,
} from "./domain/types.js";
import type { ToolContext, ToolHandler, ToolMetadata } from "./tools/types.js";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const workspaceRoot = process.cwd();
const dataDir = path.join(workspaceRoot, ".supercodex");
const dataFile = path.join(dataDir, "state.json");
const conversationsDir = path.join(dataDir, "conversations");
const workspaceFilesDirName = "supercodex-files";
const maxAgentTurns = Number(process.env.MAX_AGENT_TURNS ?? 200);
const maxOutputTokens = Number(process.env.MAX_OUTPUT_TOKENS ?? 160000);
const recentContextMessageLimit = Number(process.env.RECENT_CONTEXT_MESSAGES ?? 24);
const maxContextToolChars = Number(process.env.MAX_CONTEXT_TOOL_CHARS ?? 600_000);
const maxContextMessageChars = Number(process.env.MAX_CONTEXT_MESSAGE_CHARS ?? 20_000);
const maxToolResultChars = Number(process.env.MAX_TOOL_RESULT_CHARS ?? 12_000);
const claudeCodeExecutable = process.env.CLAUDE_CODE_EXECUTABLE || "claude";
const claudeCodeArgs = splitCommandArgs(process.env.CLAUDE_CODE_ARGS || "--print --dangerously-skip-permissions");
const claudeCodeTimeoutMs = readPositiveIntegerEnv("CLAUDE_CODE_TIMEOUT_MS", 600_000);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 12 }
});
const settings: Required<ApiConfig> = {
  baseUrl: process.env.API_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.API_KEY ?? "",
  model: process.env.API_MODEL ?? "gpt-4.1"
};

const systemPromptPath = path.join(workspaceRoot, "docs", "AGENT_SYSTEM_PROMPT.md");
const fallbackSystemPrompt = [
  "You are SuperCodex, a high-agency general office agent.",
  "Work autonomously, use tools when useful, create polished deliverables, and answer in the user's language.",
  "Never perform destructive cleanup or echo raw HTML, DOM, or JSON from browser tools."
].join(" ");
const systemPrompt = await loadSystemPrompt(systemPromptPath);

const projects = new Map<string, Project>();
const conversations = new Map<string, Conversation>();
const skills = new Map<string, Skill>();
const automations = new Map<string, Automation>();
const attachments = new Map<string, Attachment>();
const toolRegistry = new ToolRegistry();
const runningAutomations = new Set<string>();

const skillService = createSkillService({ skills, id, now });
const {
  searchSkillCatalog,
  loadSkillById,
  loadExternalSkill,
  normalizeSkill,
  publicSkillSummary,
  getActiveSkillSelection,
  formatSkillContext
} = skillService;

const webBridgeService = createWebBridgeService();
const { getWebBridgeStatus, callWebBridge, summarizeWebBridgePayload } = webBridgeService;

const agentRuntime = createAgentRuntime({
  settings,
  systemPrompt,
  workspaceRoot,
  workspaceFilesDirName,
  maxAgentTurns,
  maxOutputTokens,
  recentContextMessageLimit,
  maxToolResultChars,
  projects,
  toolRegistry,
  getConversationAttachments: (conversationId) => getConversationAttachments(conversationId),
  latestUserPrompt: (conversation) => latestUserPrompt(conversation),
  getActiveSkillSelection,
  formatAttachmentContext: (items) => formatAttachmentContext(items),
  formatSkillContext,
  summarizeConversation: (conversation) => summarizeConversation(conversation),
  toChatMessage: (message, options) => toChatMessage(message, options),
  persistStore: () => persistStore(),
  id,
  now
});
const { runAgentLoop, callLLM, getToolDefinitions } = agentRuntime;

const stateService = createStateService({
  settings,
  workspaceRoot,
  workspaceFilesDirName,
  dataDir,
  dataFile,
  conversationsDir,
  projects,
  conversations,
  skills,
  automations,
  attachments,
  toolRegistry,
  maxContextToolChars,
  maxContextMessageChars,
  callLLM,
  normalizeSkill,
  createAutomationConversation,
  maskSettings,
  id,
  now
});
const {
  initializeStore,
  persistStore,
  conversationFolderName,
  summarizeConversation,
  latestUserPrompt,
  generateConversationTitle,
  isGenericConversationTitle,
  isGenericConversationFolder,
  saveAttachment,
  saveGeneratedTextAttachment,
  publicAttachment,
  resolveConversationAttachments,
  getConversationAttachments,
  formatAttachmentContext,
  formatAttachmentLine,
  requireAttachment,
  listProjectTree,
  getAppState,
  createProject,
  createConversation,
  toChatMessage
} = stateService;

const automationRunner = createAutomationRunner({
  automations,
  runningAutomations,
  persistStore,
  getAutomationConversation,
  runAgentLoop: (conversation) => runAgentLoop(conversation),
  saveGeneratedTextAttachment,
  publicAttachment,
  id,
  now
});
const { startAutomationScheduler, runAutomation } = automationRunner;

registerServerTools({
  toolRegistry,
  workspaceRoot,
  claudeCodeExecutable,
  claudeCodeArgs,
  claudeCodeTimeoutMs,
  attachments,
  persistStore,
  searchSkillCatalog,
  loadSkillById,
  publicSkillSummary,
  resolveGeneratedFilePath,
  resolveCommandCwd,
  buildClaudeCodePrompt,
  formatAttachmentLine,
  requireAttachment,
  getWebBridgeStatus,
  callWebBridge,
  summarizeWebBridgePayload,
  id,
  now
});
await initializeStore();
startAutomationScheduler();

app.use(cors());
app.use(express.json({ limit: "4mb" }));

registerApiRoutes(app, {
  settings,
  workspaceRoot,
  upload,
  projects,
  conversations,
  skills,
  automations,
  attachments,
  runningAutomations,
  toolRegistry,
  getAppState,
  maskSettings,
  persistStore,
  createProject,
  createConversation,
  createAutomationConversation,
  listProjectTree,
  saveAttachment,
  publicAttachment,
  resolveConversationAttachments,
  normalizeAgentRunMode,
  generateConversationTitle,
  summarizeConversation,
  isGenericConversationTitle,
  isGenericConversationFolder,
  conversationFolderName,
  runAgentLoop,
  writeAgentEvent,
  callLLM,
  getToolDefinitions,
  searchSkillCatalog,
  loadSkillById,
  loadExternalSkill,
  getWebBridgeStatus,
  runAutomation,
  id,
  now
});


app.listen(port, () => {
  console.log(`SuperCodex API listening on http://localhost:${port}`);
  console.log(`Available tools: ${toolRegistry.names().join(", ")}`);
});

function writeAgentEvent(res: express.Response, event: AgentEvent) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function loadSystemPrompt(promptPath: string) {
  try {
    const content = await fs.readFile(promptPath, "utf8");
    return content.trim() || fallbackSystemPrompt;
  } catch (error) {
    console.warn(`System prompt document unavailable at ${promptPath}; using fallback prompt.`);
    return fallbackSystemPrompt;
  }
}

function normalizeAgentRunMode(mode: unknown): AgentRunMode {
  return mode === "team" ? "team" : "agent";
}

function createAutomationConversation(title: string) {
  const project = [...projects.values()][0] || createProject("SuperCodex");
  return createConversation(project.id, `自动化：${title}`);
}

function getAutomationConversation(automation: Automation) {
  const existing = automation.conversationId ? conversations.get(automation.conversationId) : undefined;
  if (existing) return existing;
  const conversation = createAutomationConversation(automation.title);
  automation.conversationId = conversation.id;
  return conversation;
}

function resolveGeneratedFilePath(inputPath: string, context: ToolContext) {
  const trimmedPath = inputPath.trim();
  const requestedPath = trimmedPath || `artifact-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  const normalized = requestedPath.replace(/\\/g, "/");
  const hasExplicitDirectory = normalized.includes("/");
  const basePath = hasExplicitDirectory || path.isAbsolute(requestedPath) ? context.workspacePath : context.outputPath;
  return safeResolvePath(requestedPath, basePath);
}

async function resolveCommandCwd(cwd: unknown, context: ToolContext) {
  const rawCwd = typeof cwd === "string" ? cwd.trim() : "";
  if (rawCwd) return safeResolvePath(rawCwd, context.workspacePath);
  await fs.mkdir(context.outputPath, { recursive: true });
  return context.outputPath;
}

function buildClaudeCodePrompt(task: string, mode: string, context: ToolContext, cwd: string) {
  const relativeCwd = path.relative(context.workspacePath, cwd) || ".";
  const modeGuidance =
    mode === "inspect"
      ? "Inspect the repository and report findings. Do not edit files unless the task explicitly requires it."
      : mode === "test"
        ? "Focus on running or improving verification for the requested behavior. Keep edits scoped to tests or necessary fixes."
        : "Implement the requested changes directly in the repository, keeping the patch focused and preserving unrelated user changes.";

  return [
    "You are being supervised by SuperCodex as the implementation agent for this local project task.",
    `Workspace root: ${context.workspacePath}`,
    `Current working directory: ${cwd} (${relativeCwd})`,
    "",
    "Task:",
    task,
    "",
    "Operating rules:",
    "- Inspect the repository before editing and follow existing architecture, style, and tests.",
    "- Keep changes scoped to the task. Do not perform destructive cleanup, git reset, git clean, or discard unrelated local changes.",
    "- Run relevant tests or build checks when feasible, and report exactly what you ran.",
    `- ${modeGuidance}`,
    "",
    "Return a concise completion report with changed files, verification, and any remaining caveats."
  ].join("\n");
}

function maskSettings() {
  return {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey ? "********" : "",
    model: settings.model,
    configured: Boolean(settings.baseUrl && settings.apiKey)
  };
}

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}
