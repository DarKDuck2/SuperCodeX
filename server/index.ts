import cors from "cors";
import "dotenv/config";
import express from "express";
import multer from "multer";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import mammoth from "mammoth";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { promisify } from "node:util";
import sharp from "sharp";
import { computeNextRunAt, normalizeScheduleText, parseAutomationInput } from "./automation/schedule.js";
import { normalizeLocalPath, safeResolvePath, sanitizeFileName } from "./core/paths.js";
import { normalizeWhitespace, stripAnsi, titleFromPrompt } from "./core/text.js";
import { executeStructuredCommand, normalizeCommandInput } from "./tools/command.js";
import { ToolRegistry } from "./tools/registry.js";
import { runRegisteredTool } from "./tools/runtime.js";
import { selectToolsForTask } from "./tools/selection.js";
import { compactJsonText, formatFetchedPage, htmlToReadableText, looksLikeHtml } from "./web/readability.js";
import {
  attachFetchedExcerpts,
  openWebSearch,
  parseSearchEngines,
  parseSearchMode,
  rankWebSearchResults
} from "./web/search.js";
import type { ToolRuntimeResult } from "./tools/runtime.js";
import type { ToolCall, ToolContext, ToolDefinition, ToolHandler, ToolMetadata, ToolTrace } from "./tools/types.js";

const execFileAsync = promisify(execFile);
const app = express();
const port = Number(process.env.PORT ?? 8787);
const workspaceRoot = process.cwd();
const dataDir = path.join(workspaceRoot, ".supercodex");
const dataFile = path.join(dataDir, "state.json");
const legacyUploadDir = path.join(dataDir, "uploads");
const conversationsDir = path.join(dataDir, "conversations");
const workspaceFilesDirName = "supercodex-files";
const maxAgentTurns = Number(process.env.MAX_AGENT_TURNS ?? 200);
const maxOutputTokens = Number(process.env.MAX_OUTPUT_TOKENS ?? 160000);
const recentContextMessageLimit = Number(process.env.RECENT_CONTEXT_MESSAGES ?? 24);
const maxContextToolChars = Number(process.env.MAX_CONTEXT_TOOL_CHARS ?? 600_000);
const maxContextMessageChars = Number(process.env.MAX_CONTEXT_MESSAGE_CHARS ?? 20_000);
const maxToolResultChars = Number(process.env.MAX_TOOL_RESULT_CHARS ?? 12_000);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 12 }
});
const officeXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  textNodeName: "#text"
});

type Role = "system" | "user" | "assistant" | "tool";

type ChatMessage = {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

type ApiConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls?: ToolCall[];
  attachments?: PublicAttachment[];
  createdAt: string;
};

type ToolMessage = {
  id: string;
  role: "tool";
  content: string;
  tool_call_id: string;
  toolName: string;
  createdAt: string;
};

type StoredMessage = Message | ToolMessage;

type Conversation = {
  id: string;
  projectId: string;
  title: string;
  shortcut?: string;
  updatedAt: string;
  messages: StoredMessage[];
  folderName?: string;
  summary?: string;
  usage?: ConversationUsage;
};

type TokenUsageMetrics = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
};

type LlmCallUsage = {
  id: string;
  model: string;
  purpose: string;
  turn?: number;
  enableTools: boolean;
  inputMessageCount: number;
  selectedToolCount: number;
  createdAt: string;
  usage: TokenUsageMetrics;
};

type ConversationUsage = {
  calls: LlmCallUsage[];
  totals: TokenUsageMetrics;
  updatedAt: string;
};

type Project = {
  id: string;
  name: string;
  rootPath?: string;
  conversations: string[];
};

type ProjectTreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: ProjectTreeNode[];
};

type Skill = {
  id: string;
  title: string;
  description: string;
  accent: string;
  connected: boolean;
  installed: boolean;
  npmPackage?: string;
  source?: "builtin" | "user" | "discovered";
  categories?: string[];
  keywords?: string[];
  toolNames?: string[];
  instructions?: string;
  manifestPath?: string;
  lastLoadedAt?: string;
};

type Automation = {
  id: string;
  title: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "never" | "running" | "success" | "error";
  lastResult?: string;
  lastError?: string;
  lastDocumentAttachmentId?: string;
  lastDocumentName?: string;
  runCount?: number;
  conversationId?: string;
  unreadCount?: number;
  runs?: AutomationRun[];
};

type AutomationRun = {
  id: string;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "error";
  result?: string;
  error?: string;
  documentAttachmentId?: string;
  documentName?: string;
  unread?: boolean;
};

type Attachment = {
  id: string;
  conversationId: string;
  originalName: string;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  kind: "image" | "text" | "file";
  source?: "upload" | "artifact";
  createdAt: string;
  derivedFrom?: string;
};

type PublicAttachment = Omit<Attachment, "path" | "fileName"> & {
  url: string;
};

type Store = {
  settings?: ApiConfig;
  projects: Project[];
  conversations: Conversation[];
  skills: Skill[];
  automations: Automation[];
  attachments?: Attachment[];
};

type ChatCompletionResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: ToolCall[];
    };
  }>;
  usage?: unknown;
  error?: { message?: string };
};

type AgentResult = {
  finalMessage: Message;
  toolCalls: Array<{ id: string; name: string; args: string; result: string; trace?: ToolTrace }>;
  turns: number;
};

type AgentEvent =
  | { type: "step"; turn: number; message: string }
  | { type: "assistant_tool_call"; turn: number; message: Message }
  | { type: "tool_result"; turn: number; message: ToolMessage }
  | { type: "usage"; turn: number; call: LlmCallUsage; totals: TokenUsageMetrics }
  | { type: "final"; turn: number; message: Message; conversation: Conversation; toolCalls: AgentResult["toolCalls"]; usage?: ConversationUsage }
  | { type: "error"; error: string };

const settings: Required<ApiConfig> = {
  baseUrl: process.env.API_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.API_KEY ?? "",
  model: process.env.API_MODEL ?? "gpt-4.1"
};

const builtinSkillCatalog: Skill[] = [
  {
    id: "messages",
    title: "团队消息",
    description: "从团队讨论中获取背景信息、待办和风险",
    accent: "slack",
    connected: false,
    installed: true,
    npmPackage: "@slack/web-api",
    source: "builtin",
    categories: ["communication", "office"],
    keywords: ["slack", "消息", "团队", "聊天", "待办"],
    toolNames: ["discover_or_load_skill", "search_web", "fetch_url"]
  },
  {
    id: "email",
    title: "电子邮件",
    description: "总结邮件、起草回复和跟进请求",
    accent: "mail",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["communication", "office"],
    keywords: ["email", "mail", "邮件", "回复", "跟进"],
    toolNames: ["discover_or_load_skill", "write_file"]
  },
  {
    id: "files",
    title: "文件处理",
    description: "审查报告、研究资料、计划和本地文件",
    accent: "drive",
    connected: false,
    installed: true,
    npmPackage: "@googleapis/drive",
    source: "builtin",
    categories: ["files", "office"],
    keywords: ["文件", "报告", "资料", "drive", "docx", "本地文件"],
    toolNames: ["list_directory", "read_file", "write_file", "search_files", "read_attachment"]
  },
  {
    id: "academic",
    title: "学术研究",
    description: "检索论文资料、整理引用、生成研究综述",
    accent: "research",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["research", "search", "office"],
    keywords: ["学术", "论文", "文献", "引用", "综述", "research", "paper", "citation"],
    toolNames: ["search_web", "fetch_url", "write_file", "run_command"]
  },
  {
    id: "slides",
    title: "PPT 演示",
    description: "生成大纲、讲稿、HTML 演示稿和 PPTX 制作脚本",
    accent: "slides",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["presentation", "office"],
    keywords: ["ppt", "pptx", "slides", "幻灯片", "演示", "讲稿"],
    toolNames: ["inspect_presentation", "write_file", "run_command", "read_attachment"]
  },
  {
    id: "pdf",
    title: "PDF 处理",
    description: "读取、摘要、提取、转换和整理 PDF 内容",
    accent: "pdf",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["pdf", "documents", "office"],
    keywords: ["pdf", "提取", "转换", "阅读", "摘要"],
    toolNames: ["extract_pdf_text", "read_attachment", "write_file", "run_command"]
  },
  {
    id: "search",
    title: "深度搜索",
    description: "联网搜索、读取网页并沉淀可追溯资料",
    accent: "search",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["search", "research"],
    keywords: ["搜索", "网页", "联网", "资料", "latest", "web", "search"],
    toolNames: ["search_web", "fetch_url", "write_file"]
  },
  {
    id: "html",
    title: "HTML 产物",
    description: "生成网页、报告页面、可交互原型和静态 HTML",
    accent: "html",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["html", "frontend", "office"],
    keywords: ["html", "网页", "页面", "前端", "原型", "报告页"],
    toolNames: ["write_file", "read_file", "run_command", "webbridge_command"]
  },
  {
    id: "excel",
    title: "Excel 表格",
    description: "清洗数据、生成 CSV/XLSX、公式和表格分析",
    accent: "excel",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["spreadsheet", "office"],
    keywords: ["excel", "xlsx", "csv", "表格", "数据", "公式", "sheet"],
    toolNames: ["read_spreadsheet", "create_spreadsheet", "read_attachment", "write_file", "run_command"]
  },
  {
    id: "documents",
    title: "文档写作",
    description: "撰写、润色、结构化长文档和工作报告",
    accent: "document",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["documents", "office"],
    keywords: ["docx", "word", "文档", "报告", "润色", "写作"],
    toolNames: ["extract_docx_text", "read_attachment", "write_file", "run_command"]
  },
  {
    id: "webbridge",
    title: "Kimi WebBridge",
    description: "控制真实浏览器、读取网页、截图和跨站操作",
    accent: "webbridge",
    connected: false,
    installed: true,
    source: "builtin",
    categories: ["browser", "search", "external"],
    keywords: ["webbridge", "浏览器", "真实浏览器", "网页操作", "browser"],
    toolNames: ["webbridge_status", "webbridge_command"]
  }
];

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

registerTools();
await initializeStore();
startAutomationScheduler();

app.use(cors());
app.use(express.json({ limit: "4mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(settings.baseUrl && settings.apiKey),
    model: settings.model,
    baseUrl: settings.baseUrl,
    workspaceRoot,
    tools: toolRegistry.names()
  });
});

app.get("/api/app", (_req, res) => {
  res.json(getAppState());
});

app.get("/api/settings", (_req, res) => {
  res.json(maskSettings());
});

app.put("/api/settings", async (req, res) => {
  const body = req.body as ApiConfig;
  if (typeof body.baseUrl === "string") settings.baseUrl = body.baseUrl.trim();
  if (typeof body.apiKey === "string") settings.apiKey = body.apiKey.trim();
  if (typeof body.model === "string") settings.model = body.model.trim();
  await persistStore();
  res.json(maskSettings());
});

app.post("/api/projects", async (req, res) => {
  const { name } = req.body as { name?: string };
  const project = createProject(name?.trim() || "新项目");
  await persistStore();
  res.status(201).json(project);
});

app.post("/api/workspaces/load", async (req, res) => {
  const body = req.body as { path?: string; name?: string };
  const requestedPath = String(body.path || "").trim();
  if (!requestedPath) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const rootPath = normalizeLocalPath(requestedPath);

  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: "path must be a directory" });
      return;
    }
  } catch (error) {
    res.status(404).json({ error: `directory not found: ${rootPath}` });
    return;
  }

  const existing = [...projects.values()].find((project) => project.rootPath === rootPath);
  const project = existing || createProject(body.name?.trim() || path.basename(rootPath), rootPath);
  const conversation = createConversation(project.id, `项目工作：${project.name}`);
  const tree = await listProjectTree(rootPath, 2);
  await persistStore();
  res.status(existing ? 200 : 201).json({ project, conversation, tree });
});

app.get("/api/projects/:id/tree", async (req, res) => {
  const project = projects.get(req.params.id);
  if (!project?.rootPath) {
    res.status(404).json({ error: "project workspace not found" });
    return;
  }

  const depth = Number(req.query.depth ?? 2);
  res.json({ rootPath: project.rootPath, tree: await listProjectTree(project.rootPath, depth) });
});

app.get("/api/projects/:id/files/content", async (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: "project not found" });
    return;
  }

  const relativePath = String(req.query.path || "").trim();
  if (!relativePath) {
    res.status(400).json({ error: "path is required" });
    return;
  }

  try {
    const rootPath = project.rootPath || workspaceRoot;
    const filePath = safeResolvePath(relativePath, rootPath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      res.status(400).json({ error: "path must be a file" });
      return;
    }
    const metadata = getFileResponseMetadata(filePath);
    res.type(metadata.contentType);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`);
    res.sendFile(filePath);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "file not found" });
  }
});

app.post("/api/projects/:id/files/open", async (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: "project not found" });
    return;
  }

  const body = req.body as { path?: string; action?: "open" | "reveal" };
  const relativePath = String(body.path || "").trim();
  if (!relativePath) {
    res.status(400).json({ error: "path is required" });
    return;
  }

  try {
    const rootPath = project.rootPath || workspaceRoot;
    const filePath = safeResolvePath(relativePath, rootPath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      res.status(400).json({ error: "path must be a file" });
      return;
    }
    await openLocalFile(filePath, body.action === "reveal" ? "reveal" : "open");
    res.json({ ok: true, path: filePath });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "file not found" });
  }
});

app.post("/api/conversations", async (req, res) => {
  const body = req.body as { projectId?: string; title?: string };
  const project = body.projectId ? projects.get(body.projectId) : [...projects.values()][0];
  if (!project) {
    res.status(400).json({ error: "project not found" });
    return;
  }

  const conversation = createConversation(
    project.id,
    body.title?.trim() || "新任务",
    `⌘${Math.min(conversations.size + 1, 9)}`
  );
  await persistStore();
  res.status(201).json(conversation);
});

app.get("/api/conversations/:id/messages", (req, res) => {
  const conversation = conversations.get(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: "conversation not found" });
    return;
  }

  res.json({ messages: conversation.messages });
});

app.post("/api/conversations/:id/attachments", upload.array("files"), async (req, res) => {
  const conversationId = String(req.params.id);
  const conversation = conversations.get(conversationId);
  if (!conversation) {
    res.status(404).json({ error: "conversation not found" });
    return;
  }

  const files = (req.files || []) as Express.Multer.File[];
  if (!files.length) {
    res.status(400).json({ error: "files are required" });
    return;
  }

  const saved = await Promise.all(files.map((file) => saveAttachment(conversation.id, file)));
  await persistStore();
  res.status(201).json({ attachments: saved.map(publicAttachment) });
});

app.get("/api/attachments/:id/content", (req, res) => {
  const attachment = attachments.get(req.params.id);
  if (!attachment) {
    res.status(404).json({ error: "attachment not found" });
    return;
  }
  res.type(attachment.mimeType);
  res.sendFile(attachment.path);
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  const conversation = conversations.get(req.params.id);
  const { content, config, attachmentIds, stream } = req.body as {
    content?: string;
    config?: ApiConfig;
    attachmentIds?: string[];
    stream?: boolean;
  };
  const prompt = content?.trim();

  if (!conversation) {
    res.status(404).json({ error: "conversation not found" });
    return;
  }

  if (!prompt) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const userMessage: Message = {
    id: id("message"),
    role: "user",
    content: prompt,
    attachments: resolveConversationAttachments(conversation.id, attachmentIds),
    createdAt: now()
  };
  conversation.messages.push(userMessage);
  const isFirstUserMessage = conversation.messages.filter((message) => message.role === "user").length === 1;
  if (isFirstUserMessage || isGenericConversationTitle(conversation.title)) {
    conversation.title = await generateConversationTitle(prompt, config);
    conversation.summary = summarizeConversation(conversation);
    if (isGenericConversationFolder(conversation.folderName)) {
      conversation.folderName = conversationFolderName(conversation.title);
    }
  }
  conversation.updatedAt = userMessage.createdAt;
  await persistStore();

  if (stream) {
    const streamAbortController = new AbortController();
    let streamCompleted = false;
    req.on("close", () => {
      if (!streamCompleted) streamAbortController.abort();
    });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    writeAgentEvent(res, { type: "step", turn: 0, message: "收到用户请求，开始规划工具使用。" });
    try {
      await runAgentLoop(conversation, config, (event) => writeAgentEvent(res, event), streamAbortController.signal);
      streamCompleted = true;
      if (!res.destroyed && !res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } catch (error) {
      streamCompleted = true;
      if (!streamAbortController.signal.aborted && !res.destroyed && !res.writableEnded) {
        writeAgentEvent(res, {
          type: "error",
          error: error instanceof Error ? error.message : "Unknown server error"
        });
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
    return;
  }

  try {
    const agentResult = await runAgentLoop(conversation, config);
    res.status(201).json({
      conversation,
      userMessage,
      assistantMessage: agentResult.finalMessage,
      toolCalls: agentResult.toolCalls,
      turns: agentResult.turns
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown server error"
    });
  }
});

app.post("/api/chat", async (req, res) => {
  const body = req.body as { messages?: ChatMessage[]; config?: ApiConfig };
  if (!body.messages?.length) {
    res.status(400).json({ error: "messages is required" });
    return;
  }

  try {
    const response = await callLLM(body.messages, body.config, false);
    res.json({
      id: id("chat"),
      model: body.config?.model ?? settings.model,
      content: response.choices?.[0]?.message?.content?.trim() || "模型没有返回内容。",
      usage: response.usage ?? null
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown server error" });
  }
});

app.get("/api/skills", (_req, res) => {
  res.json({ skills: [...skills.values()] });
});

app.get("/api/skills/search", (req, res) => {
  const query = String(req.query.q || "");
  res.json({ skills: searchSkillCatalog(query) });
});

app.post("/api/skills/:id/connect", async (req, res) => {
  const skill = skills.get(req.params.id) || loadSkillById(req.params.id, "user");
  if (!skill) {
    res.status(404).json({ error: "skill not found" });
    return;
  }

  skill.connected = true;
  skill.installed = true;
  skill.lastLoadedAt = now();
  await persistStore();
  res.json({ skill });
});

app.post("/api/skills/load", async (req, res) => {
  try {
    const skill = await loadExternalSkill(req.body as Record<string, unknown>);
    await persistStore();
    res.status(201).json({ skill });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "failed to load skill" });
  }
});

app.get("/api/tools", (_req, res) => {
  res.json({
    tools: getToolDefinitions().map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      metadata: toolRegistry.get(tool.function.name)?.metadata
    }))
  });
});

app.get("/api/webbridge/status", async (_req, res) => {
  try {
    res.json(await getWebBridgeStatus());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown WebBridge error" });
  }
});

app.post("/api/automations", async (req, res) => {
  const { title, schedule, prompt, instruction } = req.body as {
    title?: string;
    schedule?: string;
    prompt?: string;
    instruction?: string;
  };
  const parsed = parseAutomationInput({
    title,
    schedule,
    prompt,
    instruction
  });
  const conversation = createAutomationConversation(parsed.title);
  const automation: Automation = {
    id: id("auto"),
    title: parsed.title,
    schedule: parsed.schedule,
    prompt: parsed.prompt,
    enabled: true,
    createdAt: now(),
    updatedAt: now(),
    nextRunAt: computeNextRunAt(parsed.schedule),
    lastStatus: "never",
    runCount: 0,
    conversationId: conversation.id,
    unreadCount: 0,
    runs: []
  };
  automations.set(automation.id, automation);
  await persistStore();
  res.status(201).json({ automation });
});

app.get("/api/automations", (_req, res) => {
  res.json({ automations: [...automations.values()] });
});

app.post("/api/automations/preview", (req, res) => {
  const { title, schedule, prompt, instruction } = req.body as {
    title?: string;
    schedule?: string;
    prompt?: string;
    instruction?: string;
  };
  const parsed = parseAutomationInput({ title, schedule, prompt, instruction });
  res.json({
    preview: {
      ...parsed,
      nextRunAt: computeNextRunAt(parsed.schedule)
    }
  });
});

app.patch("/api/automations/:id", async (req, res) => {
  const automation = automations.get(req.params.id);
  if (!automation) {
    res.status(404).json({ error: "automation not found" });
    return;
  }

  const body = req.body as Partial<Pick<Automation, "title" | "schedule" | "prompt" | "enabled">> & {
    instruction?: string;
  };
  if (typeof body.instruction === "string") {
    const parsed = parseAutomationInput({ instruction: body.instruction });
    automation.title = parsed.title;
    automation.schedule = parsed.schedule;
    automation.prompt = parsed.prompt;
  }
  if (typeof body.title === "string") automation.title = body.title.trim() || automation.title;
  if (typeof body.schedule === "string") automation.schedule = normalizeScheduleText(body.schedule) || automation.schedule;
  if (typeof body.prompt === "string") automation.prompt = body.prompt.trim() || automation.prompt;
  if (typeof body.enabled === "boolean") automation.enabled = body.enabled;
  automation.updatedAt = now();
  automation.nextRunAt = automation.enabled ? computeNextRunAt(automation.schedule) : automation.nextRunAt;
  automation.lastStatus = automation.lastStatus || "never";
  if (!automation.conversationId) automation.conversationId = createAutomationConversation(automation.title).id;
  automation.runs = automation.runs || [];
  automation.unreadCount = automation.unreadCount || 0;
  await persistStore();
  res.json({ automation });
});

app.post("/api/automations/:id/run", async (req, res) => {
  const automation = automations.get(req.params.id);
  if (!automation) {
    res.status(404).json({ error: "automation not found" });
    return;
  }
  if (runningAutomations.has(automation.id)) {
    res.status(409).json({ error: "automation is already running" });
    return;
  }
  void runAutomation(automation, "manual");
  res.status(202).json({ automation: { ...automation, lastStatus: "running" } });
});

app.post("/api/automations/:id/read", async (req, res) => {
  const automation = automations.get(req.params.id);
  if (!automation) {
    res.status(404).json({ error: "automation not found" });
    return;
  }
  automation.runs?.forEach((run) => {
    run.unread = false;
  });
  automation.unreadCount = 0;
  automation.updatedAt = now();
  await persistStore();
  res.json({ automation });
});

app.delete("/api/automations/:id", async (req, res) => {
  if (!automations.has(req.params.id)) {
    res.status(404).json({ error: "automation not found" });
    return;
  }

  automations.delete(req.params.id);
  await persistStore();
  res.status(204).send();
});

app.get("/api/search", (req, res) => {
  const query = String(req.query.q ?? "").trim().toLowerCase();
  const results = [...conversations.values()]
    .filter((conversation) => !query || conversation.title.toLowerCase().includes(query))
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      projectId: conversation.projectId,
      type: "conversation"
    }));

  res.json({ results });
});

app.get("/api/web/search", async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  const limit = Number(req.query.limit ?? 5);
  if (!query) {
    res.status(400).json({ error: "q is required" });
    return;
  }

  try {
    res.json(await openWebSearch(workspaceRoot, query, limit));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown search error" });
  }
});

app.post("/api/tools/run-command", async (req, res) => {
  const { command, cwd } = req.body as { command?: string; cwd?: string };
  if (!command) {
    res.status(400).json({ error: "command is required" });
    return;
  }

  try {
    const normalized = normalizeCommandInput({ command });
    const result = await executeStructuredCommand(normalized, {
      cwd: safeResolvePath(cwd || ".", workspaceRoot),
      timeout: 20_000,
      maxBuffer: 1024 * 1024
    });

    res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number };
    res.status(200).json({
      ok: false,
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message
    });
  }
});

app.listen(port, () => {
  console.log(`SuperCodex API listening on http://localhost:${port}`);
  console.log(`Available tools: ${toolRegistry.names().join(", ")}`);
});

function writeAgentEvent(res: express.Response, event: AgentEvent) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function runAgentLoop(
  conversation: Conversation,
  config?: ApiConfig,
  onEvent?: (event: AgentEvent) => void,
  signal?: AbortSignal
): Promise<AgentResult> {
  const project = projects.get(conversation.projectId);
  const conversationAttachments = getConversationAttachments(conversation.id);
  const context: ToolContext = {
    workspacePath: project?.rootPath || workspaceRoot,
    outputPath: path.join(project?.rootPath || workspaceRoot, workspaceFilesDirName),
    attachments: conversationAttachments
  };
  await fs.mkdir(context.outputPath, { recursive: true });
  const outputRelativePath = path.relative(context.workspacePath, context.outputPath) || ".";
  const chatMessages: ChatMessage[] = buildAgentContextMessages(conversation, context, outputRelativePath);
  const toolCalls: AgentResult["toolCalls"] = [];

  for (let turns = 1; turns <= maxAgentTurns; turns++) {
    assertNotAborted(signal);
    onEvent?.({ type: "step", turn: turns, message: `第 ${turns} 步：模型正在判断是否需要调用工具。` });
    const selectedToolDefinitions = selectToolsForTask(toolRegistry.list(), {
      prompt: latestUserPrompt(conversation),
      context,
      ...getActiveSkillSelection()
    }).map((tool) => tool.definition);
    const response = await callLLM(chatMessages, config, true, signal, selectedToolDefinitions);
    const usageCall = recordLlmUsage(conversation, response, {
      config,
      purpose: "agent_turn",
      turn: turns,
      enableTools: true,
      inputMessageCount: chatMessages.length,
      selectedToolCount: selectedToolDefinitions.length
    });
    if (usageCall) onEvent?.({ type: "usage", turn: turns, call: usageCall, totals: conversation.usage!.totals });
    assertNotAborted(signal);
    const message = response.choices?.[0]?.message;
    if (!message) throw new Error("LLM returned no choices");

    if (message.tool_calls?.length) {
      const assistantToolMessage: Message = {
        id: id("message"),
        role: "assistant",
        content: message.content?.trim() || "",
        tool_calls: message.tool_calls,
        createdAt: now()
      };
      conversation.messages.push(assistantToolMessage);
      conversation.updatedAt = assistantToolMessage.createdAt;
      onEvent?.({ type: "assistant_tool_call", turn: turns, message: assistantToolMessage });
      chatMessages.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.tool_calls
      });

      for (const toolCall of message.tool_calls) {
        assertNotAborted(signal);
        onEvent?.({
          type: "step",
          turn: turns,
          message: `第 ${turns} 步：正在执行工具 ${toolCall.function.name}。`
        });
        const execution = await executeToolCall(toolCall, context);
        const result = execution.modelContent;
        assertNotAborted(signal);
        toolCalls.push({
          id: toolCall.id,
          name: toolCall.function.name,
          args: toolCall.function.arguments,
          result,
          trace: execution.trace
        });

        const toolMessage: ToolMessage = {
          id: id("message"),
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
          toolName: toolCall.function.name,
          createdAt: now()
        };
        conversation.messages.push(toolMessage);
        conversation.updatedAt = now();
        onEvent?.({ type: "tool_result", turn: turns, message: toolMessage });
        chatMessages.push({
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
          name: toolCall.function.name
        });
      }

      conversation.summary = summarizeConversation(conversation);
      await persistStore();
      continue;
    }

    const finalMessage: Message = {
      id: id("message"),
      role: "assistant",
      content: message.content?.trim() || "模型没有返回内容。",
      createdAt: now()
    };
    conversation.messages.push(finalMessage);
    conversation.updatedAt = finalMessage.createdAt;
    conversation.summary = summarizeConversation(conversation);
    await persistStore();
    onEvent?.({ type: "final", turn: turns, message: finalMessage, conversation, toolCalls, usage: conversation.usage });
    return { finalMessage, toolCalls, turns };
  }

  const finalResponse = await callLLM(
    [
      ...chatMessages,
      { role: "system", content: "Tool budget exhausted. Give a final answer from the available evidence." }
    ],
    config,
    false,
    signal
  );
  const usageCall = recordLlmUsage(conversation, finalResponse, {
    config,
    purpose: "agent_final_after_tool_budget",
    turn: maxAgentTurns,
    enableTools: false,
    inputMessageCount: chatMessages.length + 1,
    selectedToolCount: 0
  });
  if (usageCall) onEvent?.({ type: "usage", turn: maxAgentTurns, call: usageCall, totals: conversation.usage!.totals });
  assertNotAborted(signal);
  const finalMessage: Message = {
    id: id("message"),
    role: "assistant",
    content: finalResponse.choices?.[0]?.message?.content?.trim() || "已达到最大工具调用次数限制。",
    createdAt: now()
  };
  conversation.messages.push(finalMessage);
  conversation.updatedAt = finalMessage.createdAt;
  conversation.summary = summarizeConversation(conversation);
  await persistStore();
  onEvent?.({ type: "final", turn: maxAgentTurns, message: finalMessage, conversation, toolCalls, usage: conversation.usage });
  return { finalMessage, toolCalls, turns: maxAgentTurns };
}

async function callLLM(
  messages: ChatMessage[],
  config?: ApiConfig,
  enableTools = false,
  signal?: AbortSignal,
  selectedToolDefinitions?: ToolDefinition[]
) {
  const effective = {
    baseUrl: normalizeBaseUrl(config?.baseUrl || settings.baseUrl),
    apiKey: config?.apiKey || settings.apiKey,
    model: config?.model || settings.model
  };

  if (!effective.baseUrl || !effective.apiKey) {
    return {
      choices: [{ message: { content: fallbackOfficeReply(messages), tool_calls: undefined } }]
    } as ChatCompletionResponse;
  }

  const toolDefinitions = enableTools ? selectedToolDefinitions ?? getToolDefinitions() : [];
  const upstream = await fetch(`${effective.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${effective.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: effective.model,
      messages,
      ...(toolDefinitions.length > 0 ? { tools: toolDefinitions, tool_choice: "auto" } : {}),
      temperature: 0.2,
      max_tokens: maxOutputTokens
    }),
    signal
  });

  const payload = (await upstream.json()) as ChatCompletionResponse;
  if (!upstream.ok) {
    throw new Error(payload.error?.message ?? "Upstream API request failed");
  }

  return payload;
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Agent run aborted");
  }
}

function registerTools() {
  registerTool(
    {
      type: "function",
      function: {
        name: "discover_or_load_skill",
        description: "Search the SuperCodex skill catalog and load a relevant skill/tool package for the current task. Use this when a request mentions a capability that is missing, unclear, or better handled by a specialized office skill.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Capability or task to search for, e.g. academic PDF summary, PPT, Excel analysis, HTML report" },
            skillId: { type: "string", description: "Optional exact skill id to load from the catalog" },
            connect: { type: "boolean", description: "Whether to connect/load the selected skill. Defaults to true." }
          }
        }
      }
    },
    {
      riskLevel: "read",
      permissions: [],
      timeoutMs: 5_000,
      categories: ["orchestration"],
      keywords: ["skill", "tool", "能力", "工具", "加载"]
    },
    async (args) => {
      const query = String(args.query || args.skillId || "");
      const matches = searchSkillCatalog(query);
      const exact = args.skillId ? matches.find((skill) => skill.id === String(args.skillId)) : undefined;
      const selected = exact || matches[0];
      const shouldConnect = args.connect !== false;
      const loaded = selected && shouldConnect ? loadSkillById(selected.id, "discovered") : undefined;
      if (loaded) {
        loaded.connected = true;
        loaded.installed = true;
        loaded.lastLoadedAt = now();
        await persistStore();
      }
      return {
        ok: true,
        summary: loaded
          ? `Loaded skill: ${loaded.title}`
          : matches.length
            ? `Found ${matches.length} matching skills.`
            : "No matching skills found in the local catalog.",
        data: {
          query,
          loaded,
          matches: matches.slice(0, 6).map(publicSkillSummary)
        }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "List files and directories inside the workspace.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Directory path" } }
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["workspace:read"],
      timeoutMs: 10_000
    },
    async (args, context) => {
      const dirPath = safeResolvePath(String(args.path || "."), context.workspacePath);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries.map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`).join("\n");
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file inside the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            limit: { type: "number", description: "Max lines" }
          },
          required: ["path"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["workspace:read"],
      timeoutMs: 10_000
    },
    async (args, context) => {
      const filePath = safeResolvePath(String(args.path || ""), context.workspacePath);
      const limit = Math.max(1, Math.min(Number(args.limit) || 200, 1000));
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const visible = lines.slice(0, limit).join("\n");
      return lines.length > limit ? `${visible}\n\n... (${lines.length - limit} more lines)` : visible;
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a text file inside the workspace. Bare file names are written to the generated files directory.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "File content" }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      riskLevel: "write",
      permissions: ["workspace:write"],
      producesArtifacts: true,
      timeoutMs: 10_000,
      categories: ["files", "documents", "html", "presentation", "spreadsheet", "office"],
      skillIds: ["files", "slides", "pdf", "html", "excel", "documents", "academic"]
    },
    async (args, context) => {
      const filePath = resolveGeneratedFilePath(String(args.path || ""), context);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, String(args.content || ""), "utf-8");
      return `File written: ${path.relative(context.workspacePath, filePath)}`;
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a safe structured command. Prefer executable plus args. Legacy command strings are accepted only when they do not use shell operators. If cwd is omitted, it runs in the generated files directory for scripts and intermediate outputs.",
        parameters: {
          type: "object",
          properties: {
            executable: { type: "string", description: "Executable name or path, e.g. npm, node, rg" },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Arguments passed directly to the executable"
            },
            command: { type: "string", description: "Legacy command string for simple commands without shell operators" },
            cwd: { type: "string", description: "Working directory" }
          }
        }
      }
    },
    {
      riskLevel: "shell",
      permissions: ["shell:run", "workspace:read", "workspace:write"],
      producesArtifacts: true,
      timeoutMs: 30_000,
      categories: ["office", "documents", "presentation", "pdf", "spreadsheet", "html"],
      skillIds: ["slides", "pdf", "html", "excel", "documents", "academic"]
    },
    async (args, context) => {
      const command = normalizeCommandInput(args);
      const cwd = await resolveCommandCwd(args.cwd, context);
      const beforeFiles = await snapshotGeneratedFiles(context.outputPath);
      const result = await executeStructuredCommand(command, {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 5
      });
      const generatedFiles = diffGeneratedFiles(beforeFiles, await snapshotGeneratedFiles(context.outputPath), context);
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const generatedOutput = generatedFiles.map((filePath) => `Generated file: ${filePath}`).join("\n");
      return [
        `Command executed (${command.source}): ${command.display}`,
        output || "(Command succeeded, no output)",
        generatedOutput
      ].filter(Boolean).join("\n");
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "search_files",
        description: "Search text in files inside the current project workspace using ripgrep.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text or regex to search for" },
            path: { type: "string", description: "Optional subdirectory" },
            glob: { type: "string", description: "Optional glob, e.g. *.ts" }
          },
          required: ["query"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["workspace:read"],
      timeoutMs: 20_000
    },
    async (args, context) => {
      const query = String(args.query || "");
      const subPath = safeResolvePath(String(args.path || "."), context.workspacePath);
      const command = ["rg", "--line-number", "--hidden", "--glob", "!node_modules", "--glob", "!.git"];
      if (args.glob) command.push("--glob", String(args.glob));
      command.push(query, subPath);
      const result = await execFileAsync(command[0], command.slice(1), {
        cwd: context.workspacePath,
        timeout: 20_000,
        maxBuffer: 1024 * 1024 * 2
      }).catch((error: Error & { stdout?: string; stderr?: string; code?: number }) => {
        if (error.code === 1) return { stdout: "", stderr: "" };
        throw error;
      });
      return result.stdout.trim() || "No matches found.";
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "replace_in_file",
        description: "Replace text in a file inside the current project workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            search: { type: "string", description: "Exact text to replace" },
            replace: { type: "string", description: "Replacement text" }
          },
          required: ["path", "search", "replace"]
        }
      }
    },
    {
      riskLevel: "write",
      permissions: ["workspace:read", "workspace:write"],
      timeoutMs: 10_000
    },
    async (args, context) => {
      const filePath = safeResolvePath(String(args.path || ""), context.workspacePath);
      const search = String(args.search || "");
      const replace = String(args.replace || "");
      if (!search) throw new Error("search text is required");
      const content = await fs.readFile(filePath, "utf-8");
      if (!content.includes(search)) return `Text not found in ${path.relative(context.workspacePath, filePath)}`;
      const occurrences = content.split(search).length - 1;
      await fs.writeFile(filePath, content.split(search).join(replace), "utf-8");
      return `Updated ${path.relative(context.workspacePath, filePath)} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`;
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "run_tests",
        description: "Run the current project's test or build command.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Test command. Defaults to npm test if package.json exists, otherwise npm run build"
            }
          }
        }
      }
    },
    {
      riskLevel: "shell",
      permissions: ["shell:run", "workspace:read"],
      timeoutMs: 120_000
    },
    async (args, context) => {
      const command = normalizeCommandInput({
        command: String(args.command || (await inferTestCommand(context.workspacePath)))
      });
      try {
        const result = await executeStructuredCommand(command, {
          cwd: context.workspacePath,
          timeout: 120_000,
          maxBuffer: 1024 * 1024 * 5
        });
        return [
          `Command executed (${command.source}): ${command.display}`,
          [result.stdout, result.stderr].filter(Boolean).join("\n") || "(Tests completed, no output)"
        ].join("\n");
      } catch (error) {
        const err = error as Error & { stdout?: string; stderr?: string; code?: number };
        return [
          `Command failed (${err.code ?? 1}): ${command.display}`,
          err.stdout || "",
          err.stderr || err.message
        ]
          .filter(Boolean)
          .join("\n");
      }
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "list_attachments",
        description: "List files and images uploaded or pasted into the current conversation.",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 5_000
    },
    async (_args, context) => {
      if (!context.attachments.length) return "No attachments in this conversation.";
      return context.attachments.map(formatAttachmentLine).join("\n");
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "read_attachment",
        description: "Read a text attachment or return metadata for an uploaded image/file.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "Attachment id from list_attachments" },
            limit: { type: "number", description: "Max lines for text attachments" }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 10_000,
      categories: ["files", "documents", "pdf", "spreadsheet", "office"],
      skillIds: ["files", "pdf", "excel", "documents", "academic"]
    },
    async (args, context) => {
      const attachment = findContextAttachment(context, String(args.attachmentId || ""));
      if (!attachment) throw new Error("Attachment not found in this conversation");
      if (attachment.kind !== "text") return formatAttachmentLine(attachment);
      const limit = Math.max(1, Math.min(Number(args.limit) || 300, 1200));
      const content = await fs.readFile(attachment.path, "utf-8");
      const lines = content.split("\n");
      const visible = lines.slice(0, limit).join("\n");
      return lines.length > limit ? `${visible}\n\n... (${lines.length - limit} more lines)` : visible;
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "extract_pdf_text",
        description: "Extract readable text from an uploaded PDF attachment for summary, review, citation, or conversion tasks.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "PDF attachment id from list_attachments" },
            pages: {
              type: "array",
              items: { type: "number" },
              description: "Optional 1-based page numbers to extract. Omit to extract the full PDF."
            },
            maxChars: { type: "number", description: "Maximum characters to return, 2000-50000. Defaults to 20000." }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 30_000,
      categories: ["pdf", "documents", "office", "research"],
      skillIds: ["pdf", "documents", "academic"]
    },
    async (args, context) => {
      const attachment = requireAttachment(context, String(args.attachmentId || ""));
      if (!isPdfAttachment(attachment)) throw new Error("Attachment is not a PDF");
      const maxChars = clampNumber(args.maxChars, 2_000, 50_000, 20_000);
      const pages = Array.isArray(args.pages)
        ? args.pages.map((page) => Number(page)).filter((page) => Number.isInteger(page) && page > 0)
        : undefined;
      const text = await extractPdfAttachmentText(attachment.path, pages);
      const compact = compactOfficeText(text, maxChars);
      return {
        ok: true,
        summary: [
          `PDF extracted: ${attachment.originalName}`,
          pages?.length ? `Pages: ${pages.join(", ")}` : "Pages: all available pages",
          `Characters returned: ${compact.length}`,
          "",
          compact || "(No readable text found. The PDF may be scanned or image-only.)"
        ].join("\n"),
        metadata: { attachmentId: attachment.id, originalName: attachment.originalName, pages }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "read_spreadsheet",
        description: "Read an uploaded CSV/XLS/XLSX spreadsheet and return workbook sheets, headers, sample rows, and basic dimensions.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "Spreadsheet attachment id from list_attachments" },
            sheet: { type: "string", description: "Optional sheet name to inspect for XLSX files" },
            maxRows: { type: "number", description: "Maximum rows per sheet to return, 5-100. Defaults to 30." },
            maxColumns: { type: "number", description: "Maximum columns per row to return, 3-50. Defaults to 20." }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 20_000,
      categories: ["spreadsheet", "office"],
      skillIds: ["excel"]
    },
    async (args, context) => {
      const attachment = requireAttachment(context, String(args.attachmentId || ""));
      if (!isSpreadsheetAttachment(attachment)) throw new Error("Attachment is not a supported spreadsheet");
      const maxRows = clampNumber(args.maxRows, 5, 100, 30);
      const maxColumns = clampNumber(args.maxColumns, 3, 50, 20);
      const result = await readSpreadsheetAttachment(attachment, String(args.sheet || ""), maxRows, maxColumns);
      return {
        ok: true,
        summary: result,
        metadata: { attachmentId: attachment.id, originalName: attachment.originalName }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "extract_docx_text",
        description: "Extract readable text from an uploaded Word DOCX attachment for rewriting, summary, or report tasks.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "DOCX attachment id from list_attachments" },
            maxChars: { type: "number", description: "Maximum characters to return, 2000-50000. Defaults to 20000." }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 20_000,
      categories: ["documents", "office"],
      skillIds: ["documents"]
    },
    async (args, context) => {
      const attachment = requireAttachment(context, String(args.attachmentId || ""));
      if (!isDocxAttachment(attachment)) throw new Error("Attachment is not a DOCX file");
      const maxChars = clampNumber(args.maxChars, 2_000, 50_000, 20_000);
      const result = await mammoth.extractRawText({ path: attachment.path });
      const compact = compactOfficeText(result.value, maxChars);
      const warnings = result.messages?.map((message) => message.message).filter(Boolean) || [];
      return {
        ok: true,
        summary: [
          `DOCX extracted: ${attachment.originalName}`,
          warnings.length ? `Warnings: ${warnings.slice(0, 5).join("; ")}` : "",
          `Characters returned: ${compact.length}`,
          "",
          compact || "(No readable text found.)"
        ].filter(Boolean).join("\n"),
        metadata: { attachmentId: attachment.id, originalName: attachment.originalName, warnings }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "create_spreadsheet",
        description: "Create an XLSX workbook artifact from structured sheet data. Use this for cleaned data, analysis tables, trackers, and office-ready spreadsheet deliverables.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Output .xlsx path. Bare file names are written to the generated files directory." },
            sheets: {
              type: "array",
              description: "Workbook sheets. Each sheet has name, optional columns, and rows. Rows can be arrays or objects.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  columns: { type: "array", items: { type: "string" } },
                  rows: { type: "array", items: {} }
                }
              }
            }
          },
          required: ["path", "sheets"]
        }
      }
    },
    {
      riskLevel: "write",
      permissions: ["workspace:write"],
      producesArtifacts: true,
      timeoutMs: 20_000,
      categories: ["spreadsheet", "office"],
      skillIds: ["excel"]
    },
    async (args, context) => {
      const outputPath = ensureXlsxPath(resolveGeneratedFilePath(String(args.path || "spreadsheet.xlsx"), context));
      const sheets = normalizeWorkbookSheets(args.sheets);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await writeXlsxWorkbook(outputPath, sheets);
      const relativePath = path.relative(context.workspacePath, outputPath);
      return {
        ok: true,
        summary: [
          `Generated file: ${relativePath}`,
          `Workbook sheets: ${sheets.map((sheet) => `${sheet.name} (${sheet.rows.length} rows)`).join(", ")}`
        ].join("\n"),
        artifacts: [{ title: path.basename(outputPath), path: relativePath, kind: "table" }],
        metadata: { path: relativePath, sheets: sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length })) }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "inspect_presentation",
        description: "Inspect an uploaded PPTX presentation and return slide titles/text for review, rewriting, or deck generation.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "PPTX attachment id from list_attachments" },
            maxSlides: { type: "number", description: "Maximum slides to return, 1-80. Defaults to 30." },
            maxCharsPerSlide: { type: "number", description: "Maximum text characters per slide, 300-4000. Defaults to 1500." }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "read",
      permissions: ["attachments:read"],
      timeoutMs: 20_000,
      categories: ["presentation", "office"],
      skillIds: ["slides"]
    },
    async (args, context) => {
      const attachment = requireAttachment(context, String(args.attachmentId || ""));
      if (!isPptxAttachment(attachment)) throw new Error("Attachment is not a PPTX file");
      const maxSlides = clampNumber(args.maxSlides, 1, 80, 30);
      const maxCharsPerSlide = clampNumber(args.maxCharsPerSlide, 300, 4_000, 1_500);
      const summary = await inspectPresentationAttachment(attachment.path, attachment.originalName, maxSlides, maxCharsPerSlide);
      return {
        ok: true,
        summary,
        metadata: { attachmentId: attachment.id, originalName: attachment.originalName }
      };
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "transform_image",
        description: "Create a modified copy of an uploaded image. Supports resize, crop, rotate, grayscale, blur, sharpen, flip, flop, and format conversion.",
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "Image attachment id" },
            outputName: { type: "string", description: "Optional output file name" },
            width: { type: "number", description: "Resize width in pixels" },
            height: { type: "number", description: "Resize height in pixels" },
            crop: {
              type: "object",
              properties: {
                left: { type: "number" },
                top: { type: "number" },
                width: { type: "number" },
                height: { type: "number" }
              }
            },
            rotate: { type: "number", description: "Rotation degrees" },
            grayscale: { type: "boolean" },
            blur: { type: "number" },
            sharpen: { type: "boolean" },
            flip: { type: "boolean" },
            flop: { type: "boolean" },
            format: { type: "string", description: "png, jpeg, or webp" }
          },
          required: ["attachmentId"]
        }
      }
    },
    {
      riskLevel: "write",
      permissions: ["attachments:read", "attachments:write", "workspace:write"],
      producesArtifacts: true,
      timeoutMs: 30_000
    },
    async (args, context) => {
      const attachment = findContextAttachment(context, String(args.attachmentId || ""));
      if (!attachment) throw new Error("Attachment not found in this conversation");
      if (attachment.kind !== "image") throw new Error("Attachment is not an image");

      const format = normalizeImageFormat(String(args.format || path.extname(attachment.originalName).slice(1) || "png"));
      const outputName =
        sanitizeFileName(String(args.outputName || "")) ||
        `${path.parse(attachment.originalName).name}-edited.${format === "jpeg" ? "jpg" : format}`;
      const artifactDir = context.outputPath;
      await fs.mkdir(artifactDir, { recursive: true });
      const outputPath = path.join(artifactDir, `${id("image")}-${outputName}`);

      let pipeline = sharp(attachment.path);
      const crop = args.crop as Record<string, unknown> | undefined;
      if (crop) {
        pipeline = pipeline.extract({
          left: Math.max(0, Number(crop.left) || 0),
          top: Math.max(0, Number(crop.top) || 0),
          width: Math.max(1, Number(crop.width) || 1),
          height: Math.max(1, Number(crop.height) || 1)
        });
      }
      if (args.width || args.height) {
        pipeline = pipeline.resize({
          width: args.width ? Math.max(1, Number(args.width)) : undefined,
          height: args.height ? Math.max(1, Number(args.height)) : undefined,
          fit: "inside",
          withoutEnlargement: false
        });
      }
      if (args.rotate) pipeline = pipeline.rotate(Number(args.rotate));
      if (args.grayscale) pipeline = pipeline.grayscale();
      if (args.blur) pipeline = pipeline.blur(Math.max(0.3, Math.min(Number(args.blur), 100)));
      if (args.sharpen) pipeline = pipeline.sharpen();
      if (args.flip) pipeline = pipeline.flip();
      if (args.flop) pipeline = pipeline.flop();
      await pipeline.toFormat(format).toFile(outputPath);

      const stat = await fs.stat(outputPath);
      const derived: Attachment = {
        id: id("attachment"),
        conversationId: attachment.conversationId,
        originalName: outputName,
        fileName: path.basename(outputPath),
        mimeType: `image/${format}`,
        size: stat.size,
        path: outputPath,
        kind: "image",
        source: "artifact",
        createdAt: now(),
        derivedFrom: attachment.id
      };
      attachments.set(derived.id, derived);
      await persistStore();
      return `Created image attachment ${derived.id}: ${derived.originalName}\nURL: /api/attachments/${derived.id}/content\nPath: ${derived.path}`;
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "fetch_url",
        description: "Fetch a URL and return cleaned readable content, not raw HTML.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL to fetch" } },
          required: ["url"]
        }
      }
    },
    {
      riskLevel: "network",
      permissions: ["network:fetch"],
      timeoutMs: 30_000,
      categories: ["search", "research"],
      skillIds: ["search", "academic"]
    },
    async (args) => {
      const url = String(args.url || "");
      if (!/^https?:\/\//.test(url)) throw new Error("Only http/https URLs are allowed");
      const response = await fetch(url);
      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      if (contentType.includes("text/html") || looksLikeHtml(text)) {
        return formatFetchedPage(url, text);
      }
      if (contentType.includes("application/json")) {
        return compactJsonText(text, 8000);
      }
      return normalizeWhitespace(stripAnsi(text)).slice(0, 8000);
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web for information. Returns compact top results.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            num: { type: "number", description: "Number of final ranked results, 1-8" },
            engines: {
              type: "array",
              items: { type: "string" },
              description: "Optional search engines to combine: bing, duckduckgo, brave, startpage, baidu, sogou, exa, csdn, juejin, linuxdo"
            },
            searchMode: {
              type: "string",
              enum: ["request", "auto", "playwright"],
              description: "Optional open-websearch mode. playwright can improve Bing quality but is slower."
            },
            fetchTop: {
              type: "number",
              description: "Fetch readable content from the top N ranked pages for verification, 0-4. Defaults to 3."
            }
          },
          required: ["query"]
        }
      }
    },
    {
      riskLevel: "network",
      permissions: ["network:fetch"],
      timeoutMs: 45_000,
      categories: ["search", "research"],
      skillIds: ["search", "academic"]
    },
    async (args) => {
      const query = String(args.query || "");
      const num = Math.max(1, Math.min(Number(args.num) || 5, 8));
      const engines = parseSearchEngines(args.engines);
      const searchMode = parseSearchMode(args.searchMode);
      const fetchTop = Math.max(0, Math.min(Number(args.fetchTop ?? 3) || 0, 4));
      const requestedLimit = Math.min(50, Math.max(num * 3, num * Math.max(1, engines.length)));
      const payload = await openWebSearch(workspaceRoot, query, requestedLimit, { engines, searchMode });
      if (!payload.results.length) {
        const failures = payload.partialFailures?.length ? `\nPartial failures: ${JSON.stringify(payload.partialFailures).slice(0, 1000)}` : "";
        return `No results found.${failures}`;
      }
      const ranked = rankWebSearchResults(query, payload.results).slice(0, num);
      await attachFetchedExcerpts(ranked, fetchTop);
      const failureNote = payload.partialFailures?.length
        ? `\n\nPartial search failures:\n${JSON.stringify(payload.partialFailures, null, 2).slice(0, 1500)}`
        : "";
      return [
        `Search query: ${payload.query}`,
        `Engines: ${payload.engines.join(", ")}`,
        `Retrieved: ${payload.totalResults}; returned ranked: ${ranked.length}`,
        "",
        ...ranked
        .map((result, index) =>
          [
            `${index + 1}. ${result.title}`,
            `URL: ${result.url}`,
            `Domain: ${result.domain}`,
            `Score: ${result.rankScore}`,
            result.description ? `Description: ${result.description}` : "",
            result.engine ? `Engine: ${result.engine}` : "",
            result.qualitySignals.length ? `Signals: ${result.qualitySignals.join(", ")}` : "",
            result.matchedTerms.length ? `Matched terms: ${result.matchedTerms.join(", ")}` : "",
            result.fetched?.title ? `Fetched title: ${result.fetched.title}` : "",
            result.fetched?.description ? `Fetched description: ${result.fetched.description}` : "",
            result.fetched?.excerpt ? `Fetched excerpt: ${result.fetched.excerpt}` : "",
            result.fetchError ? `Fetch warning: ${result.fetchError}` : ""
          ].filter(Boolean).join("\n")
        )
        .join("\n\n"),
        failureNote
      ].filter(Boolean).join("\n");
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "webbridge_status",
        description: "Check Kimi WebBridge daemon and browser extension status.",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    },
    {
      riskLevel: "external",
      permissions: ["external:webbridge"],
      timeoutMs: 10_000,
      categories: ["browser"],
      skillIds: ["webbridge"]
    },
    async () => {
      return JSON.stringify(await getWebBridgeStatus());
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "webbridge_command",
        description: "Send a safe command to Kimi WebBridge for real-browser work. Supports status-independent actions such as list_tabs and snapshot when extension is connected.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "One of: list_tabs, snapshot, navigate, find_tab"
            },
            args: {
              type: "object",
              description: "Arguments for the WebBridge action"
            },
            session: {
              type: "string",
              description: "Stable session name for this task"
            }
          },
          required: ["action", "session"]
        }
      }
    },
    {
      riskLevel: "external",
      permissions: ["external:webbridge"],
      timeoutMs: 30_000,
      categories: ["browser", "html"],
      skillIds: ["webbridge", "html"]
    },
    async (args) => {
      const action = String(args.action || "");
      if (!["list_tabs", "snapshot", "navigate", "find_tab"].includes(action)) {
        throw new Error(`Unsupported WebBridge action: ${action}`);
      }
      const payload = await callWebBridge(action, args.args ?? {}, String(args.session || "supercodex"));
      return summarizeWebBridgePayload(action, payload);
    }
  );
}

function registerTool(
  definition: ToolDefinition,
  metadata: ToolMetadata,
  handler: ToolHandler
) {
  toolRegistry.register(definition, metadata, handler);
}

function getToolDefinitions() {
  return toolRegistry.definitions();
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

function buildAgentContextMessages(conversation: Conversation, context: ToolContext, outputRelativePath: string): ChatMessage[] {
  const recentMessages = selectRecentContextMessages(conversation.messages);
  const omittedCount = Math.max(0, conversation.messages.length - recentMessages.length);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "system",
      content: [
        `Current local project workspace: ${context.workspacePath}.`,
        `Generated files directory: ${context.outputPath}.`,
        `When the user does not specify an output path, save generated files, scripts, and intermediate outputs under ${outputRelativePath}.`,
        "run_command without cwd runs in the generated files directory. Pass cwd explicitly when you need to run commands from the project root or a subdirectory."
      ].join(" ")
    },
    {
      role: "system",
      content: formatAttachmentContext(context.attachments)
    },
    {
      role: "system",
      content: formatSkillContext()
    }
  ];

  if (omittedCount > 0) {
    messages.push({
      role: "system",
      content: [
        `Conversation memory summary (${omittedCount} older messages omitted from the live prompt):`,
        conversation.summary || summarizeConversation(conversation),
        "Rely on the recent messages below for exact wording. Use tools to re-read files or data when exact details are needed."
      ].join("\n")
    });
  }

  messages.push(...recentMessages.map((message) => toChatMessage(message, { compact: true })));
  return messages;
}

function selectRecentContextMessages(messages: StoredMessage[]) {
  const recent = messages.slice(-recentContextMessageLimit);
  while (recent[0]?.role === "tool") {
    recent.shift();
  }
  return recent;
}

function recordLlmUsage(
  conversation: Conversation,
  response: ChatCompletionResponse,
  input: {
    config?: ApiConfig;
    purpose: string;
    turn?: number;
    enableTools: boolean;
    inputMessageCount: number;
    selectedToolCount: number;
  }
) {
  const usage = normalizeUsage(response.usage);
  if (!usage) return undefined;
  const call: LlmCallUsage = {
    id: id("usage"),
    model: response.model || input.config?.model || settings.model,
    purpose: input.purpose,
    turn: input.turn,
    enableTools: input.enableTools,
    inputMessageCount: input.inputMessageCount,
    selectedToolCount: input.selectedToolCount,
    createdAt: now(),
    usage
  };
  const previous = conversation.usage?.calls || [];
  const calls = [...previous, call].slice(-500);
  conversation.usage = {
    calls,
    totals: sumUsage(calls.map((item) => item.usage)),
    updatedAt: call.createdAt
  };
  return call;
}

function normalizeUsage(usage: unknown): TokenUsageMetrics | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const input = usage as Record<string, unknown>;
  const inputTokens = numericUsage(input, "input_tokens", "prompt_tokens");
  const outputTokens = numericUsage(input, "output_tokens", "completion_tokens");
  const totalTokens = numericUsage(input, "total_tokens") || inputTokens + outputTokens;
  const cacheHitTokens = numericUsage(input, "cache_hit_tokens", "prompt_cache_hit_tokens", "cached_tokens");
  const cacheMissTokens = numericUsage(input, "cache_miss_tokens", "prompt_cache_miss_tokens");
  return { inputTokens, outputTokens, totalTokens, cacheHitTokens, cacheMissTokens };
}

function numericUsage(input: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function sumUsage(items: TokenUsageMetrics[]): TokenUsageMetrics {
  return items.reduce(
    (total, item) => ({
      inputTokens: total.inputTokens + item.inputTokens,
      outputTokens: total.outputTokens + item.outputTokens,
      totalTokens: total.totalTokens + item.totalTokens,
      cacheHitTokens: total.cacheHitTokens + item.cacheHitTokens,
      cacheMissTokens: total.cacheMissTokens + item.cacheMissTokens
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
  );
}

async function executeToolCall(toolCall: ToolCall, context: ToolContext): Promise<ToolRuntimeResult> {
  const tool = toolRegistry.get(toolCall.function.name);
  if (!tool) {
    const reason = `Unknown tool: ${toolCall.function.name}`;
    return {
      modelContent: reason,
      trace: {
        id: toolCall.id,
        toolName: toolCall.function.name,
        args: {},
        policy: { action: "deny", reason },
        startedAt: now(),
        finishedAt: now(),
        result: { ok: false, summary: reason, error: reason }
      }
    };
  }
  return runRegisteredTool(toolCall, tool, context, {
    sanitize: sanitizeToolResult,
    maxModelContentLength: maxToolResultChars
  });
}

function sanitizeToolResult(toolName: string, result: string) {
  if (!looksLikeHtml(result)) return result;
  return [
    `${toolName} returned HTML-like content. SuperCodex extracted readable text instead of raw markup.`,
    htmlToReadableText(result)
  ].join("\n");
}

function searchSkillCatalog(query: string) {
  const normalizedQuery = normalizeWhitespace(query).toLowerCase();
  const catalog = mergeSkillCatalog();
  if (!normalizedQuery) return catalog.map(publicSkillSummary);
  return catalog
    .map((skill) => ({ skill, score: scoreSkill(skill, normalizedQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.title.localeCompare(right.skill.title))
    .map((entry) => publicSkillSummary(entry.skill));
}

function mergeSkillCatalog() {
  const merged = new Map<string, Skill>();
  for (const skill of builtinSkillCatalog) merged.set(skill.id, normalizeSkill(skill));
  for (const skill of skills.values()) {
    const base = merged.get(skill.id);
    merged.set(skill.id, normalizeSkill({ ...base, ...skill }));
  }
  return [...merged.values()];
}

function scoreSkill(skill: Skill, query: string) {
  const haystack = [
    skill.id,
    skill.title,
    skill.description,
    ...(skill.categories || []),
    ...(skill.keywords || []),
    ...(skill.toolNames || [])
  ].join(" ").toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const term of terms) {
    if (skill.id.toLowerCase() === term) score += 8;
    if (skill.title.toLowerCase().includes(term)) score += 5;
    if (haystack.includes(term)) score += 2;
  }
  if (haystack.includes(query)) score += 6;
  return score;
}

function loadSkillById(skillId: string, source: Skill["source"] = "builtin") {
  const existing = skills.get(skillId);
  const builtin = builtinSkillCatalog.find((skill) => skill.id === skillId);
  const skill = existing || builtin;
  if (!skill) return undefined;
  const normalized = normalizeSkill({
    ...builtin,
    ...skill,
    source: skill.source || source,
    installed: true
  });
  skills.set(normalized.id, normalized);
  return normalized;
}

async function loadExternalSkill(input: Record<string, unknown>) {
  const manifestPath = String(input.path || input.manifestPath || "").trim();
  let manifest = input;
  let instructions = typeof input.instructions === "string" ? input.instructions : "";

  if (manifestPath) {
    const targetPath = normalizeLocalPath(manifestPath);
    const stat = await fs.stat(targetPath);
    const filePath = stat.isDirectory() ? path.join(targetPath, "SKILL.md") : targetPath;
    const content = await fs.readFile(filePath, "utf-8");
    manifest = parseSkillMarkdown(content, filePath);
    instructions ||= content.slice(0, 4000);
  }

  const idValue = String(manifest.id || manifest.name || manifest.title || "").trim();
  if (!idValue) throw new Error("skill id or title is required");
  const skillId = slugifySkillId(idValue);
  const skill: Skill = normalizeSkill({
    id: skillId,
    title: String(manifest.title || manifest.name || idValue),
    description: String(manifest.description || "用户加载的自定义能力"),
    accent: String(manifest.accent || "custom"),
    connected: input.connect !== false,
    installed: true,
    source: "user",
    categories: toStringList(manifest.categories),
    keywords: toStringList(manifest.keywords),
    toolNames: toStringList(manifest.toolNames || manifest.tools),
    instructions,
    manifestPath: manifestPath || undefined,
    lastLoadedAt: now()
  });
  skills.set(skill.id, skill);
  return skill;
}

function parseSkillMarkdown(content: string, filePath: string) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  const data: Record<string, unknown> = {};
  if (frontmatter) {
    for (const line of frontmatter[1].split("\n")) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      data[key] = value.includes(",") ? value.split(",").map((item) => item.trim()).filter(Boolean) : value.trim();
    }
  }
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(path.dirname(filePath));
  const description = content
    .replace(/^---\n[\s\S]*?\n---/, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  return {
    ...data,
    title: data.title || title,
    description: data.description || description || "用户加载的 Markdown skill",
    instructions: content.slice(0, 4000)
  };
}

function normalizeSkill(skill: Skill): Skill {
  return {
    ...skill,
    source: skill.source || "builtin",
    categories: uniqueStrings(skill.categories || []),
    keywords: uniqueStrings(skill.keywords || []),
    toolNames: uniqueStrings(skill.toolNames || []),
    connected: Boolean(skill.connected),
    installed: skill.installed !== false
  };
}

function publicSkillSummary(skill: Skill) {
  return {
    id: skill.id,
    title: skill.title,
    description: skill.description,
    accent: skill.accent,
    connected: skill.connected,
    installed: skill.installed,
    source: skill.source,
    categories: skill.categories || [],
    keywords: skill.keywords || [],
    toolNames: skill.toolNames || []
  };
}

function getActiveSkillSelection() {
  const active = [...skills.values()].filter((skill) => skill.connected);
  return {
    activeSkillIds: active.map((skill) => skill.id),
    activeSkillCategories: uniqueStrings(active.flatMap((skill) => skill.categories || [])),
    activeSkillKeywords: uniqueStrings(active.flatMap((skill) => skill.keywords || []))
  };
}

function formatSkillContext() {
  const active = [...skills.values()].filter((skill) => skill.connected);
  const catalog = mergeSkillCatalog();
  return [
    active.length
      ? `Loaded skills: ${active.map((skill) => `${skill.id} (${skill.title})`).join(", ")}.`
      : "No optional skills are currently loaded.",
    `Skill catalog: ${catalog
      .map((skill) => `${skill.id}=${skill.title} [${(skill.categories || []).join("/")}]`)
      .join("; ")}.`,
    "If a task would benefit from a catalog skill that is not loaded, call discover_or_load_skill first, then continue the task."
  ].join(" ");
}

function toStringList(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function slugifySkillId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || id("skill");
}

function startAutomationScheduler() {
  void runDueAutomations();
  setInterval(() => {
    void runDueAutomations();
  }, 30_000);
}

async function runDueAutomations() {
  const dueAutomations = [...automations.values()].filter((automation) => {
    if (!automation.enabled || runningAutomations.has(automation.id)) return false;
    if (!automation.nextRunAt) automation.nextRunAt = computeNextRunAt(automation.schedule);
    return Boolean(automation.nextRunAt && Date.parse(automation.nextRunAt) <= Date.now());
  });

  for (const automation of dueAutomations) {
    await runAutomation(automation, "schedule");
  }
}

async function runAutomation(automation: Automation, trigger: AutomationRun["trigger"] = "schedule") {
  runningAutomations.add(automation.id);
  const run: AutomationRun = {
    id: id("run"),
    trigger,
    startedAt: now(),
    status: "running"
  };
  automation.runs = [run, ...(automation.runs || [])].slice(0, 20);
  automation.lastStatus = "running";
  automation.lastRunAt = run.startedAt;
  automation.updatedAt = run.startedAt;
  await persistStore();

  try {
    const conversation = getAutomationConversation(automation);
    const userMessage: Message = {
      id: id("message"),
      role: "user",
      content: [
        `执行定时任务：${automation.title}`,
        "",
        automation.prompt,
        "",
        "请直接完成任务并给出可以展示给用户的结果。"
      ].join("\n"),
      createdAt: now()
    };
    conversation.messages.push(userMessage);
    conversation.updatedAt = userMessage.createdAt;
    await persistStore();

    const result = await runAgentLoop(conversation);
    const documentAttachment = await saveGeneratedTextAttachment(
      conversation.id,
      `${sanitizeFileName(automation.title || "automation-result")}-${new Date().toISOString().slice(0, 10)}.md`,
      [
        `# ${automation.title}`,
        "",
        `- 执行时间：${formatLocalDateTime(new Date())}`,
        `- 时间规则：${automation.schedule}`,
        "",
        "## 任务",
        "",
        automation.prompt,
        "",
        "## 结果",
        "",
        result.finalMessage.content
      ].join("\n")
    );
    result.finalMessage.attachments = [
      ...(result.finalMessage.attachments || []),
      publicAttachment(documentAttachment)
    ];
    run.status = "success";
    run.finishedAt = now();
    run.result = result.finalMessage.content.slice(0, 1000);
    run.documentAttachmentId = documentAttachment.id;
    run.documentName = documentAttachment.originalName;
    run.unread = true;
    automation.lastStatus = "success";
    automation.lastResult = result.finalMessage.content.slice(0, 1000);
    automation.lastError = "";
    automation.lastDocumentAttachmentId = documentAttachment.id;
    automation.lastDocumentName = documentAttachment.originalName;
    automation.runCount = (automation.runCount || 0) + 1;
    automation.unreadCount = (automation.unreadCount || 0) + 1;
  } catch (error) {
    run.status = "error";
    run.finishedAt = now();
    run.error = error instanceof Error ? error.message : "Unknown automation error";
    run.unread = true;
    automation.lastStatus = "error";
    automation.lastError = run.error;
    automation.unreadCount = (automation.unreadCount || 0) + 1;
  } finally {
    automation.nextRunAt = computeNextRunAt(automation.schedule, new Date(Date.now() + 1000));
    automation.updatedAt = now();
    runningAutomations.delete(automation.id);
    await persistStore();
  }
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

async function initializeStore() {
  try {
    const raw = await fs.readFile(dataFile, "utf-8");
    const store = JSON.parse(raw) as Store;
    if (typeof store.settings?.baseUrl === "string") settings.baseUrl = store.settings.baseUrl;
    if (typeof store.settings?.apiKey === "string") settings.apiKey = store.settings.apiKey;
    if (typeof store.settings?.model === "string") settings.model = store.settings.model;
    store.projects.forEach((project) => projects.set(project.id, project));
    store.conversations.forEach((conversation) => conversations.set(conversation.id, conversation));
    store.skills.forEach((skill) => skills.set(skill.id, skill));
    store.automations.forEach((automation) => automations.set(automation.id, automation));
    store.attachments?.forEach((attachment) => attachments.set(attachment.id, attachment));
    ensureSeedSkills();
    migrateAttachments();
    migrateConversationStorage();
    migrateAutomations();
    await persistStore();
  } catch {
    seedState();
    migrateAttachments();
    migrateConversationStorage();
    migrateAutomations();
    await persistStore();
  }
}

async function persistStore() {
  await fs.mkdir(dataDir, { recursive: true });
  const store: Store = {
    settings: {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model
    },
    projects: [...projects.values()],
    conversations: [...conversations.values()],
    skills: [...skills.values()],
    automations: [...automations.values()],
    attachments: [...attachments.values()]
  };
  await fs.writeFile(dataFile, JSON.stringify(store, null, 2), "utf-8");
  await persistConversationFiles();
}

function migrateConversationStorage() {
  for (const conversation of conversations.values()) {
    if (!conversation.folderName || isGenericConversationFolder(conversation.folderName)) {
      conversation.folderName = conversationFolderName(conversation.title || "conversation");
    }
    if (!conversation.summary) {
      conversation.summary = summarizeConversation(conversation);
    }
  }
}

async function persistConversationFiles() {
  await fs.mkdir(conversationsDir, { recursive: true });
  await Promise.all([...conversations.values()].map((conversation) => persistConversationFilesFor(conversation)));
}

async function persistConversationFilesFor(conversation: Conversation) {
  const dir = getConversationDir(conversation);
  await fs.mkdir(path.join(dir, "uploads"), { recursive: true });
  await fs.mkdir(path.join(dir, "artifacts"), { recursive: true });
  await fs.writeFile(path.join(dir, "overview.md"), renderConversationOverview(conversation), "utf-8");
  await fs.writeFile(
    path.join(dir, "messages.json"),
    JSON.stringify(
      {
        id: conversation.id,
        projectId: conversation.projectId,
        title: conversation.title,
        shortcut: conversation.shortcut,
        updatedAt: conversation.updatedAt,
        summary: conversation.summary || summarizeConversation(conversation),
        usage: conversation.usage,
        messages: conversation.messages
      },
      null,
      2
    ),
    "utf-8"
  );
}

function getConversationDir(conversation: Conversation) {
  if (!conversation.folderName) conversation.folderName = conversationFolderName(conversation.title || "conversation");
  return path.join(conversationsDir, `${conversation.folderName}-${shortId(conversation.id)}`);
}

function conversationFolderName(title: string) {
  const safe = sanitizeFileName(title || "conversation")
    .replace(/\.+$/g, "")
    .slice(0, 72);
  return safe || "conversation";
}

function renderConversationOverview(conversation: Conversation) {
  const createdAt = getConversationCreatedAt(conversation);
  const conversationAttachments = getConversationAttachments(conversation.id);
  const uploaded = conversationAttachments.filter((attachment) => attachment.source !== "artifact");
  const artifacts = conversationAttachments.filter((attachment) => attachment.source === "artifact");
  return [
    `# ${conversation.title}`,
    "",
    `- 对话 ID：${conversation.id}`,
    `- 创建时间：${createdAt ? formatLocalDateTime(new Date(createdAt)) : "-"}`,
    `- 最近更新：${formatLocalDateTime(new Date(conversation.updatedAt))}`,
    `- 消息数：${conversation.messages.length}`,
    `- 用户上传：${uploaded.length}`,
    `- 产生文件：${artifacts.length}`,
    conversation.usage ? `- Token：input ${conversation.usage.totals.inputTokens} / output ${conversation.usage.totals.outputTokens} / cache hit ${conversation.usage.totals.cacheHitTokens} / cache miss ${conversation.usage.totals.cacheMissTokens}` : "",
    "",
    "## 总结",
    "",
    conversation.summary || summarizeConversation(conversation),
    "",
    "## 用户上传数据",
    "",
    uploaded.length ? uploaded.map((attachment) => `- ${attachment.originalName} (${attachment.mimeType}, ${attachment.size} bytes)`).join("\n") : "暂无",
    "",
    "## 产生的文件数据",
    "",
    artifacts.length ? artifacts.map((attachment) => `- ${attachment.originalName} (${attachment.mimeType}, ${attachment.size} bytes)`).join("\n") : "暂无"
  ].join("\n");
}

function summarizeConversation(conversation: Conversation) {
  const userMessages = conversation.messages
    .filter((message): message is Message => message.role === "user")
    .map((message) => message.content)
    .filter(Boolean);
  const assistantMessages = conversation.messages
    .filter((message): message is Message => message.role === "assistant")
    .map((message) => message.content)
    .filter(Boolean);
  const firstUser = userMessages[0] || "暂无用户请求";
  const lastAssistant = assistantMessages.at(-1) || "";
  return [
    `本次对话围绕“${firstUser.slice(0, 120)}”展开。`,
    lastAssistant ? `最近一次助手回复摘要：${lastAssistant.slice(0, 180)}` : "当前还没有形成完整回复。"
  ].join("\n");
}

function latestUserPrompt(conversation: Conversation) {
  return [...conversation.messages].reverse().find((message): message is Message => message.role === "user")?.content || "";
}

async function generateConversationTitle(prompt: string, config?: ApiConfig) {
  const fallback = classifyConversationTitle(prompt);
  const effectiveApiKey = config?.apiKey || settings.apiKey;
  if (!effectiveApiKey) return fallback;
  try {
    const response = await callLLM(
      [
        {
          role: "system",
          content:
            "你是对话标题分类器。根据用户请求生成一个中文短标题，要求：8到16个字，名词短语，不要标点，不要解释，不要照抄完整用户输入。"
        },
        { role: "user", content: prompt }
      ],
      config,
      false
    );
    const title = sanitizeGeneratedTitle(response.choices?.[0]?.message?.content || "");
    return title || fallback;
  } catch {
    return fallback;
  }
}

function sanitizeGeneratedTitle(value: string) {
  return normalizeWhitespace(value)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[。！？!?,，；;：:]+$/g, "")
    .slice(0, 32);
}

function classifyConversationTitle(prompt: string) {
  const text = normalizeWhitespace(prompt);
  if (/自动化|定时|每天|每周|提醒|下班前|早上|上午|下午|晚上|每\d+\s*(?:h|小时)/i.test(text)) {
    return "自动化任务设置";
  }
  if (/新闻|资讯|热搜|日报|早报|晚报/.test(text)) return "新闻资讯整理";
  if (/A股|股票|早盘|收盘|行情|市场|指数|板块/i.test(text)) return "市场行情分析";
  if (/PPT|幻灯片|演示|deck/i.test(text)) return "演示文稿制作";
  if (/图片|照片|裁剪|缩放|旋转|格式/.test(text)) return "图片处理任务";
  if (/项目|代码|构建|测试|bug|修复|实现|架构/.test(text)) return "项目代码工作";
  if (/邮件|回复|email|mail/i.test(text)) return "邮件处理任务";
  if (/文件|文档|整理|总结|报告/.test(text)) return "文档整理总结";
  return titleFromPrompt(text);
}

function isGenericConversationTitle(title: string) {
  return ["新任务", "暂无对话"].includes(title) || title.startsWith("项目工作：");
}

function isGenericConversationFolder(folderName?: string) {
  if (!folderName) return true;
  return /^(新任务|暂无对话|项目工作|conversation|attachment)$/.test(folderName);
}

function getConversationCreatedAt(conversation: Conversation) {
  return conversation.messages[0]?.createdAt || conversation.updatedAt;
}

function shortId(value: string) {
  return value.replace(/^[^_]+_/, "").slice(0, 8);
}

async function saveAttachment(conversationId: string, file: Express.Multer.File): Promise<Attachment> {
  const conversation = conversations.get(conversationId);
  if (!conversation) throw new Error("conversation not found");
  const safeName = sanitizeFileName(file.originalname || "attachment");
  const fileId = id("attachment");
  const conversationUploadDir = path.join(getConversationDir(conversation), "uploads");
  await fs.mkdir(conversationUploadDir, { recursive: true });
  const filePath = path.join(conversationUploadDir, `${fileId}-${safeName}`);
  await fs.writeFile(filePath, file.buffer);
  const attachment: Attachment = {
    id: fileId,
    conversationId,
    originalName: safeName,
    fileName: path.basename(filePath),
    mimeType: file.mimetype || "application/octet-stream",
    size: file.size,
    path: filePath,
    kind: inferAttachmentKind(file.mimetype, safeName),
    source: "upload",
    createdAt: now()
  };
  attachments.set(attachment.id, attachment);
  return attachment;
}

async function saveGeneratedTextAttachment(conversationId: string, originalName: string, content: string) {
  const conversation = conversations.get(conversationId);
  if (!conversation) throw new Error("conversation not found");
  const safeName = sanitizeFileName(originalName || "automation-result.md");
  const fileId = id("attachment");
  const project = projects.get(conversation.projectId);
  const artifactDir = path.join(project?.rootPath || workspaceRoot, workspaceFilesDirName);
  await fs.mkdir(artifactDir, { recursive: true });
  const filePath = path.join(artifactDir, `${fileId}-${safeName}`);
  await fs.writeFile(filePath, content, "utf-8");
  const stat = await fs.stat(filePath);
  const attachment: Attachment = {
    id: fileId,
    conversationId,
    originalName: safeName,
    fileName: path.basename(filePath),
    mimeType: "text/markdown; charset=utf-8",
    size: stat.size,
    path: filePath,
    kind: "text",
    source: "artifact",
    createdAt: now()
  };
  attachments.set(attachment.id, attachment);
  return attachment;
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

type GeneratedFileSnapshot = Map<string, { mtimeMs: number; size: number }>;

async function snapshotGeneratedFiles(rootPath: string): Promise<GeneratedFileSnapshot> {
  const snapshot: GeneratedFileSnapshot = new Map();
  const ignored = new Set(["node_modules", ".git", ".supercodex", "dist", "dist-server"]);

  async function walk(currentPath: string, depth: number) {
    if (depth > 6 || snapshot.size > 2000) return;
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(entryPath);
        snapshot.set(entryPath, { mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // Files can disappear while a command is still settling.
      }
    }
  }

  await walk(rootPath, 0);
  return snapshot;
}

function diffGeneratedFiles(
  before: GeneratedFileSnapshot,
  after: GeneratedFileSnapshot,
  context: ToolContext
) {
  return [...after.entries()]
    .filter(([filePath, meta]) => {
      const previous = before.get(filePath);
      return !previous || previous.size !== meta.size || meta.mtimeMs > previous.mtimeMs + 1;
    })
    .map(([filePath]) => path.relative(context.workspacePath, filePath))
    .filter((filePath) => filePath && !filePath.startsWith(".."))
    .sort();
}

function getFileResponseMetadata(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".py": "text/x-python; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".tsx": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  };

  return {
    contentType: contentTypes[extension] || "application/octet-stream"
  };
}

async function openLocalFile(filePath: string, action: "open" | "reveal") {
  if (process.platform === "darwin") {
    if (action === "reveal") {
      await execFileAsync("open", ["-R", filePath]);
      return;
    }
    if (isTextLikeFile(filePath)) {
      try {
        await execFileAsync("open", ["-t", filePath]);
        return;
      } catch {
        // Fall through to the normal opener before revealing in Finder.
      }
    }
    try {
      await execFileAsync("open", [filePath]);
      return;
    } catch {
      await execFileAsync("open", ["-R", filePath]);
    }
    return;
  }

  if (process.platform === "win32") {
    if (action === "reveal") {
      await execFileAsync("explorer.exe", [`/select,${filePath}`]);
      return;
    }
    await execFileAsync("explorer.exe", [filePath]);
    return;
  }

  await execFileAsync("xdg-open", [action === "reveal" ? path.dirname(filePath) : filePath]);
}

function isTextLikeFile(filePath: string) {
  return new Set([
    ".c",
    ".cc",
    ".cpp",
    ".css",
    ".csv",
    ".go",
    ".h",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".sql",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml"
  ]).has(path.extname(filePath).toLowerCase());
}

function publicAttachment(attachment: Attachment) {
  return {
    id: attachment.id,
    conversationId: attachment.conversationId,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
    source: attachment.source,
    createdAt: attachment.createdAt,
    url: `/api/attachments/${attachment.id}/content`,
    derivedFrom: attachment.derivedFrom
  } satisfies PublicAttachment;
}

function resolveConversationAttachments(conversationId: string, attachmentIds?: string[]) {
  const requested = new Set(attachmentIds || []);
  return [...attachments.values()]
    .filter((attachment) => attachment.conversationId === conversationId && requested.has(attachment.id))
    .map(publicAttachment);
}

function getConversationAttachments(conversationId: string) {
  return [...attachments.values()].filter((attachment) => attachment.conversationId === conversationId);
}

function formatAttachmentContext(items: Attachment[]) {
  if (!items.length) return "No files or images are attached to this conversation.";
  return [
    "Conversation attachments are available to tools. Use list_attachments/read_attachment/transform_image when relevant.",
    ...items.map(formatAttachmentLine)
  ].join("\n");
}

function formatAttachmentLine(attachment: Attachment) {
  return [
    `${attachment.id}: ${attachment.originalName}`,
    `kind=${attachment.kind}`,
    `mime=${attachment.mimeType}`,
    `size=${attachment.size}`,
    `path=${attachment.path}`,
    attachment.derivedFrom ? `derivedFrom=${attachment.derivedFrom}` : ""
  ]
    .filter(Boolean)
    .join(" | ");
}

function requireAttachment(context: ToolContext, attachmentId: string) {
  const attachment = findContextAttachment(context, attachmentId);
  if (!attachment) throw new Error("Attachment not found in this conversation");
  return attachment;
}

function isPdfAttachment(attachment: ToolContext["attachments"][number]) {
  return attachment.mimeType === "application/pdf" || /\.pdf$/i.test(attachment.originalName);
}

function isDocxAttachment(attachment: ToolContext["attachments"][number]) {
  return (
    attachment.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(attachment.originalName)
  );
}

function isPptxAttachment(attachment: ToolContext["attachments"][number]) {
  return (
    attachment.mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    /\.pptx$/i.test(attachment.originalName)
  );
}

function isSpreadsheetAttachment(attachment: ToolContext["attachments"][number]) {
  return (
    attachment.mimeType === "text/csv" ||
    attachment.mimeType === "application/vnd.ms-excel" ||
    attachment.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    /\.(csv|xls|xlsx)$/i.test(attachment.originalName)
  );
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function compactOfficeText(text: string, maxChars: number) {
  const normalized = text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  const headLength = Math.floor(maxChars * 0.75);
  const tailLength = maxChars - headLength;
  return [
    normalized.slice(0, headLength).trimEnd(),
    `[content truncated: omitted ${normalized.length - maxChars} chars]`,
    normalized.slice(-tailLength).trimStart()
  ].join("\n\n");
}

async function extractPdfAttachmentText(filePath: string, pages?: number[]) {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const result = pages?.length ? await parser.getText({ partial: pages }) : await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy();
  }
}

async function readSpreadsheetAttachment(
  attachment: ToolContext["attachments"][number],
  requestedSheet: string,
  maxRows: number,
  maxColumns: number
) {
  if (/\.csv$/i.test(attachment.originalName) || attachment.mimeType === "text/csv") {
    const csv = await fs.readFile(attachment.path, "utf-8");
    const rows = parseCsvRows(csv).slice(0, maxRows).map((row) => row.slice(0, maxColumns));
    return [
      `Spreadsheet read: ${attachment.originalName}`,
      "Format: CSV",
      `Rows returned: ${rows.length}`,
      "",
      formatTablePreview(rows)
    ].join("\n");
  }

  if (!/\.xlsx$/i.test(attachment.originalName)) {
    throw new Error("Only CSV and XLSX spreadsheet parsing is currently supported");
  }

  const zip = await JSZip.loadAsync(await fs.readFile(attachment.path));
  const sharedStrings = await readXlsxSharedStrings(zip);
  const workbookSheets = await readXlsxWorkbookSheets(zip);
  const selectedSheets = requestedSheet
    ? workbookSheets.filter((sheet) => sheet.name.toLowerCase() === requestedSheet.toLowerCase())
    : workbookSheets;
  const sheets = selectedSheets.length ? selectedSheets : workbookSheets.slice(0, 5);
  const previews: string[] = [];

  for (const sheet of sheets.slice(0, 5)) {
    const file = zip.file(sheet.path);
    if (!file) continue;
    const xml = await file.async("string");
    const parsed = officeXmlParser.parse(xml);
    const rows = extractSheetRows(parsed, sharedStrings, maxRows, maxColumns);
    previews.push([
      `Sheet: ${sheet.name}`,
      `Path: ${sheet.path}`,
      `Rows returned: ${rows.length}`,
      "",
      formatTablePreview(rows)
    ].join("\n"));
  }

  return [
    `Spreadsheet read: ${attachment.originalName}`,
    `Workbook sheets: ${workbookSheets.map((sheet) => sheet.name).join(", ") || "unknown"}`,
    requestedSheet && !selectedSheets.length ? `Requested sheet not found: ${requestedSheet}` : "",
    "",
    previews.join("\n\n---\n\n") || "(No readable worksheet rows found.)"
  ].filter(Boolean).join("\n");
}

type WorkbookSheet = {
  name: string;
  columns: string[];
  rows: Array<Array<string | number | boolean>>;
};

function ensureXlsxPath(filePath: string) {
  return /\.xlsx$/i.test(filePath) ? filePath : `${filePath.replace(/\.[^.\\/]+$/, "")}.xlsx`;
}

function normalizeWorkbookSheets(value: unknown): WorkbookSheet[] {
  const inputSheets = Array.isArray(value) ? value : [];
  const sheets = inputSheets.map((input, index) => normalizeWorkbookSheet(input, index)).filter((sheet) => sheet.rows.length || sheet.columns.length);
  if (!sheets.length) throw new Error("At least one sheet with columns or rows is required");
  return sheets.slice(0, 12);
}

function normalizeWorkbookSheet(value: unknown, index: number): WorkbookSheet {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rowsInput = Array.isArray(input.rows) ? input.rows : [];
  const explicitColumns = Array.isArray(input.columns) ? input.columns.map((column) => String(column)) : [];
  const objectColumns = rowsInput.flatMap((row) => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []);
  const columns = uniqueStrings([...explicitColumns, ...objectColumns]).slice(0, 100);
  const rows = rowsInput.slice(0, 10_000).map((row) => normalizeWorkbookRow(row, columns)).filter((row) => row.some((cell) => String(cell).trim() !== ""));
  const name = sanitizeSheetName(String(input.name || `Sheet ${index + 1}`), index);
  return { name, columns, rows };
}

function normalizeWorkbookRow(value: unknown, columns: string[]): Array<string | number | boolean> {
  if (Array.isArray(value)) return value.slice(0, 100).map(normalizeCellScalar);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const keys = columns.length ? columns : Object.keys(input);
    return keys.slice(0, 100).map((key) => normalizeCellScalar(input[key]));
  }
  return [normalizeCellScalar(value)];
}

function normalizeCellScalar(value: unknown): string | number | boolean {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function sanitizeSheetName(value: string, index: number) {
  const cleaned = value.replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31);
  return cleaned || `Sheet ${index + 1}`;
}

async function writeXlsxWorkbook(filePath: string, sheets: WorkbookSheet[]) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", xlsxContentTypes(sheets.length));
  zip.folder("_rels")?.file(".rels", xlsxRootRels());
  const xl = zip.folder("xl");
  xl?.file("workbook.xml", xlsxWorkbookXml(sheets));
  xl?.file("styles.xml", xlsxStylesXml());
  xl?.folder("_rels")?.file("workbook.xml.rels", xlsxWorkbookRels(sheets.length));
  const worksheets = xl?.folder("worksheets");
  sheets.forEach((sheet, index) => worksheets?.file(`sheet${index + 1}.xml`, xlsxWorksheetXml(sheet)));
  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.writeFile(filePath, content);
}

function xlsxContentTypes(sheetCount: number) {
  const sheetOverrides = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("");
  return xmlDocument([
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    sheetOverrides,
    "</Types>"
  ].join(""));
}

function xlsxRootRels() {
  return xmlDocument([
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    "</Relationships>"
  ].join(""));
}

function xlsxWorkbookXml(sheets: WorkbookSheet[]) {
  const sheetNodes = sheets.map((sheet, index) =>
    `<sheet name="${xmlAttr(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  ).join("");
  return xmlDocument([
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheets>${sheetNodes}</sheets>`,
    "</workbook>"
  ].join(""));
}

function xlsxWorkbookRels(sheetCount: number) {
  const sheetRels = Array.from({ length: sheetCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join("");
  return xmlDocument([
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    sheetRels,
    `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    "</Relationships>"
  ].join(""));
}

function xlsxStylesXml() {
  return xmlDocument([
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>',
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>',
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>',
    "</styleSheet>"
  ].join(""));
}

function xlsxWorksheetXml(sheet: WorkbookSheet) {
  const rows = sheet.columns.length ? [sheet.columns, ...sheet.rows] : sheet.rows;
  const rowNodes = rows.map((row, rowIndex) => {
    const cellNodes = row.map((cell, columnIndex) => xlsxCellXml(cell, rowIndex + 1, columnIndex + 1)).join("");
    return `<row r="${rowIndex + 1}">${cellNodes}</row>`;
  }).join("");
  return xmlDocument([
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<sheetData>${rowNodes}</sheetData>`,
    "</worksheet>"
  ].join(""));
}

function xlsxCellXml(value: string | number | boolean, row: number, column: number) {
  const ref = `${columnName(column)}${row}`;
  if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t>${xmlText(value)}</t></is></c>`;
}

function columnName(index: number) {
  let value = index;
  let name = "";
  while (value > 0) {
    const mod = (value - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    value = Math.floor((value - mod) / 26);
  }
  return name;
}

function xmlDocument(body: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function xmlText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlAttr(value: string) {
  return xmlText(value).replace(/"/g, "&quot;");
}

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index++;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (char !== "\r") cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

async function readXlsxSharedStrings(zip: JSZip) {
  const file = zip.file("xl/sharedStrings.xml");
  if (!file) return [];
  const parsed = officeXmlParser.parse(await file.async("string"));
  const items = asArray(parsed?.sst?.si);
  return items.map((item) => collectTextNodes(item).join(""));
}

async function readXlsxWorkbookSheets(zip: JSZip) {
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) {
    return zip.file(/^xl\/worksheets\/sheet\d+\.xml$/).map((file, index) => ({
      name: `Sheet ${index + 1}`,
      path: file.name
    }));
  }

  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  const rels = new Map<string, string>();
  if (relsFile) {
    const parsedRels = officeXmlParser.parse(await relsFile.async("string"));
    for (const rel of asArray(parsedRels?.Relationships?.Relationship)) {
      if (rel?.Id && rel?.Target) {
        rels.set(String(rel.Id), `xl/${String(rel.Target).replace(/^\/?xl\//, "")}`);
      }
    }
  }

  const parsedWorkbook = officeXmlParser.parse(await workbookFile.async("string"));
  const sheets = asArray(parsedWorkbook?.workbook?.sheets?.sheet);
  return sheets.map((sheet, index) => ({
    name: String(sheet?.name || `Sheet ${index + 1}`),
    path: rels.get(String(sheet?.id || sheet?.["r:id"])) || `xl/worksheets/sheet${index + 1}.xml`
  }));
}

function extractSheetRows(parsed: unknown, sharedStrings: string[], maxRows: number, maxColumns: number) {
  const worksheet = parsed as { worksheet?: { sheetData?: { row?: unknown } } };
  const rows = asArray(worksheet?.worksheet?.sheetData?.row);
  return rows.slice(0, maxRows).map((row) => {
    const cells = asArray((row as { c?: unknown })?.c);
    return cells.slice(0, maxColumns).map((cell) => cellValue(cell, sharedStrings));
  });
}

function cellValue(cell: unknown, sharedStrings: string[]) {
  const input = cell as { t?: string; v?: unknown; is?: unknown };
  const rawValue = valueText(input?.v);
  if (input?.t === "s") return sharedStrings[Number(rawValue)] || "";
  if (input?.t === "inlineStr") return collectTextNodes(input.is).join("");
  return rawValue;
}

function valueText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && "#text" in value) return String((value as Record<string, unknown>)["#text"] || "");
  return String(value);
}

function formatTablePreview(rows: string[][]) {
  if (!rows.length) return "(No rows found.)";
  return rows
    .map((row, index) => {
      const cells = row.map((cell) => normalizeWhitespace(cell).slice(0, 120));
      return `${index + 1}: ${cells.join(" | ")}`;
    })
    .join("\n");
}

async function inspectPresentationAttachment(filePath: string, originalName: string, maxSlides: number, maxCharsPerSlide: number) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const slideFiles = zip
    .file(/^ppt\/slides\/slide\d+\.xml$/)
    .sort((left, right) => numericSuffix(left.name) - numericSuffix(right.name))
    .slice(0, maxSlides);
  const slides: string[] = [];

  for (const file of slideFiles) {
    const parsed = officeXmlParser.parse(await file.async("string"));
    const texts = collectTextNodes(parsed).map(normalizeWhitespace).filter(Boolean);
    const body = compactOfficeText(texts.join("\n"), maxCharsPerSlide);
    slides.push([
      `Slide ${numericSuffix(file.name) || slides.length + 1}`,
      body || "(No readable text found.)"
    ].join("\n"));
  }

  return [
    `PPTX inspected: ${originalName}`,
    `Slides returned: ${slides.length}`,
    "",
    slides.join("\n\n---\n\n") || "(No readable slides found.)"
  ].join("\n");
}

function collectTextNodes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [];
  if (Array.isArray(value)) return value.flatMap(collectTextNodes);
  if (typeof value !== "object") return [];
  const input = value as Record<string, unknown>;
  const current = typeof input.t === "string" || typeof input.t === "number" ? [String(input.t)] : [];
  const textNode = typeof input["#text"] === "string" || typeof input["#text"] === "number" ? [String(input["#text"])] : [];
  const nested = Object.entries(input)
    .filter(([key]) => key !== "t" && key !== "#text")
    .flatMap(([, child]) => collectTextNodes(child));
  return [...current, ...textNode, ...nested];
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function numericSuffix(value: string) {
  return Number(value.match(/(\d+)(?=\.xml$)/)?.[1] || 0);
}

function findContextAttachment(context: ToolContext, attachmentId: string) {
  return context.attachments.find((attachment) => attachment.id === attachmentId);
}

async function listProjectTree(rootPath: string, maxDepth: number) {
  const ignored = new Set(["node_modules", ".git", "dist", "build", ".next", ".supercodex"]);
  async function walk(currentPath: string, depth: number): Promise<ProjectTreeNode[]> {
    if (depth > maxDepth) return [];
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    const visible = entries
      .filter((entry) => !ignored.has(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 80);

    const nodes: ProjectTreeNode[] = [];
    for (const entry of visible) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(rootPath, entryPath) || ".";
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: "dir" as const,
          children: await walk(entryPath, depth + 1)
        });
      } else {
        nodes.push({ name: entry.name, path: relativePath, type: "file" as const });
      }
    }
    return nodes;
  }

  return walk(rootPath, 0);
}

function seedState() {
  ensureSeedSkills();
  if (projects.size > 0) return;
  const superCodex = createProject("SuperCodex");
  createConversation(superCodex.id, "帮我写一个项目，要求界面...", "⌘1");
  const agora = createProject("AgoraAI");
  createConversation(agora.id, "暂无对话");
  const searchAgent = createProject("SearchAgent-Zero");
  createConversation(searchAgent.id, "讲讲这个文件的内容", "⌘2");
  const desktop = createProject("Desktop");
  createConversation(desktop.id, "@github openai/codex.git", "⌘3");
}

function migrateAttachments() {
  for (const attachment of attachments.values()) {
    if (attachment.source) continue;
    attachment.source =
      attachment.derivedFrom || attachment.path.includes(`${path.sep}artifacts${path.sep}`)
        ? "artifact"
        : "upload";
  }
}

function migrateAutomations() {
  for (const automation of automations.values()) {
    automation.prompt = automation.prompt || automation.title || "执行这个定时任务。";
    automation.schedule = normalizeScheduleText(automation.schedule || "手动触发") || "手动触发";
    automation.lastStatus = automation.lastStatus || "never";
    automation.runCount = automation.runCount || 0;
    automation.unreadCount = automation.unreadCount || 0;
    automation.runs = automation.runs || [];
    automation.updatedAt = automation.updatedAt || automation.createdAt;
    if (!automation.conversationId) {
      automation.conversationId = createAutomationConversation(automation.title).id;
    }
    if (automation.enabled && !automation.nextRunAt) {
      automation.nextRunAt = computeNextRunAt(automation.schedule);
    }
  }
}

function ensureSeedSkills() {
  const existing = new Map(skills);
  for (const catalogSkill of builtinSkillCatalog) {
    const previous = existing.get(catalogSkill.id);
    skills.set(catalogSkill.id, normalizeSkill({
      ...catalogSkill,
      ...previous,
      connected: previous?.connected ?? catalogSkill.connected,
      installed: catalogSkill.installed || previous?.installed || catalogSkill.id === "webbridge"
    }));
  }
  for (const [skillId, skill] of existing) {
    if (!skills.has(skillId)) skills.set(skillId, normalizeSkill(skill));
  }
}

function getAppState() {
  return {
    settings: maskSettings(),
    projects: [...projects.values()].map((project) => ({
      ...project,
      conversations: project.conversations
        .map((conversationId) => conversations.get(conversationId))
        .filter((conversation): conversation is Conversation => Boolean(conversation))
        .map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          shortcut: conversation.shortcut,
          updatedAt: conversation.updatedAt,
          messageCount: conversation.messages.length
        }))
    })),
    skills: [...skills.values()],
    automations: [...automations.values()],
    tools: toolRegistry.names()
  };
}

function createProject(name: string, rootPath?: string) {
  const project: Project = { id: id("project"), name, rootPath, conversations: [] };
  projects.set(project.id, project);
  return project;
}

function createConversation(projectId: string, title: string, shortcut?: string) {
  const conversation: Conversation = {
    id: id("conversation"),
    projectId,
    title,
    shortcut,
    updatedAt: now(),
    messages: [],
    folderName: conversationFolderName(title)
  };
  conversations.set(conversation.id, conversation);
  projects.get(projectId)?.conversations.push(conversation.id);
  return conversation;
}

function toChatMessage(message: StoredMessage, options: { compact?: boolean } = {}): ChatMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: options.compact ? compactMessageContent(message.content, maxContextToolChars, message.toolName) : message.content,
      tool_call_id: message.tool_call_id,
      name: message.toolName
    };
  }
  const content = message.attachments?.length
    ? `${message.content}\n\nAttached files:\n${message.attachments
        .map((attachment) =>
          `${attachment.id}: ${attachment.originalName} (${attachment.kind}, ${attachment.mimeType}, ${attachment.size} bytes, ${attachment.url})`
        )
        .join("\n")}`
    : message.content || null;
  return {
    role: message.role,
    content: options.compact ? compactNullableMessageContent(content, maxContextMessageChars, message.role) : content,
    tool_calls: message.tool_calls
  };
}

function compactNullableMessageContent(content: string | null, limit: number, label: string) {
  if (content === null) return null;
  return compactMessageContent(content, limit, label);
}

function compactMessageContent(content: string, limit: number, label: string) {
  if (content.length <= limit) return content;
  const headLength = Math.floor(limit * 0.7);
  const tailLength = Math.max(0, limit - headLength - 180);
  const omitted = content.length - headLength - tailLength;
  return [
    content.slice(0, headLength).trimEnd(),
    "",
    `[${label} message compacted: omitted ${omitted} characters.]`,
    "",
    tailLength ? content.slice(-tailLength).trimStart() : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function inferAttachmentKind(mimeType: string, fileName: string): Attachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("text/")) return "text";
  if (/\.(md|txt|csv|json|xml|html|css|js|jsx|ts|tsx|py|java|go|rs|rb|php|sql|yaml|yml|toml|ini|log)$/i.test(fileName)) {
    return "text";
  }
  return "file";
}

function normalizeImageFormat(value: string): "png" | "jpeg" | "webp" {
  const normalized = value.toLowerCase().replace("jpg", "jpeg");
  if (normalized === "png" || normalized === "jpeg" || normalized === "webp") return normalized;
  return "png";
}

async function inferTestCommand(projectPath: string) {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(projectPath, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    if (packageJson.scripts?.test && !/no test specified/i.test(packageJson.scripts.test)) {
      return "npm test";
    }
    if (packageJson.scripts?.lint) return "npm run lint";
    if (packageJson.scripts?.build) return "npm run build";
  } catch {
    // Non-JavaScript projects can provide an explicit command.
  }
  return "npm run build";
}

async function getWebBridgeStatus() {
  const binPath = path.join(process.env.HOME || "", ".kimi-webbridge", "bin", "kimi-webbridge");
  const { stdout } = await execFileAsync(binPath, ["status"], {
    timeout: 10_000,
    maxBuffer: 1024 * 256
  });
  return JSON.parse(stdout) as {
    running: boolean;
    extension_connected: boolean;
    port: number;
    version: string;
    extension_version?: string;
  };
}

async function callWebBridge(action: string, args: unknown, session: string) {
  const status = await getWebBridgeStatus();
  if (!status.running) {
    throw new Error("Kimi WebBridge daemon is not running");
  }
  if (!status.extension_connected && action !== "list_tabs") {
    throw new Error("Kimi WebBridge extension is not connected. Install/enable it at https://kimi.com/features/webbridge");
  }
  const response = await fetch(`http://127.0.0.1:${status.port}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, args: args || {}, session })
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(payload?.error || `WebBridge command failed: ${response.status}`);
  }
  return payload;
}

function summarizeWebBridgePayload(action: string, payload: unknown) {
  const cleaned = cleanWebPayload(payload);
  if (typeof cleaned === "string") {
    return `WebBridge ${action} result:\n${cleaned.slice(0, 8000)}`;
  }
  return `WebBridge ${action} result:\n${JSON.stringify(cleaned, null, 2).slice(0, 9000)}`;
}

function cleanWebPayload(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") {
    if (looksLikeHtml(value)) return htmlToReadableText(value).slice(0, 4000);
    return normalizeWhitespace(stripAnsi(value)).slice(0, 4000);
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => cleanWebPayload(item, depth + 1));
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const preferredKeys = [
      "action",
      "status",
      "title",
      "url",
      "text",
      "visibleText",
      "summary",
      "tabs",
      "result",
      "results",
      "error"
    ];
    const keys = Object.keys(input);
    const orderedKeys = [
      ...preferredKeys.filter((key) => key in input),
      ...keys.filter((key) => !preferredKeys.includes(key)).slice(0, 20)
    ];
    for (const key of orderedKeys) {
      if (/^(html|outerHTML|innerHTML|dom|snapshot|source|markup)$/i.test(key)) {
        const text = typeof input[key] === "string" ? htmlToReadableText(input[key] as string) : cleanWebPayload(input[key], depth + 1);
        output[`${key}Text`] = text;
        continue;
      }
      output[key] = cleanWebPayload(input[key], depth + 1);
    }
    return output;
  }
  return value;
}

function fallbackOfficeReply(messages: ChatMessage[]) {
  const task = [...messages].reverse().find((message) => message.role === "user")?.content || "这个任务";
  return [
    `我已经收到：${task}`,
    "",
    "当前未配置模型 API，我会以本地模式给出处理框架：",
    "1. 明确目标和交付物。",
    "2. 收集相关邮件、文档、聊天记录或网页资料。",
    "3. 提炼结论、风险和下一步行动。",
    "4. 生成可复用的回复、报告、清单或自动化流程。"
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

function normalizeBaseUrl(value?: string) {
  return value ? value.replace(/\/$/, "") : "";
}

function now() {
  return new Date().toISOString();
}

function formatLocalDateTime(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}
