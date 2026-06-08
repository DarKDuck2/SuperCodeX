import cors from "cors";
import "dotenv/config";
import express from "express";
import multer from "multer";
import { exec, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const app = express();
const port = Number(process.env.PORT ?? 8787);
const workspaceRoot = process.cwd();
const dataDir = path.join(workspaceRoot, ".supercodex");
const dataFile = path.join(dataDir, "state.json");
const legacyUploadDir = path.join(dataDir, "uploads");
const conversationsDir = path.join(dataDir, "conversations");
const maxAgentTurns = 200;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 12 }
});

type Role = "system" | "user" | "assistant" | "tool";

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage = {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
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

type WebSearchResult = {
  title: string;
  url: string;
  description?: string;
  source?: string;
  engine?: string;
};

type WebSearchPayload = {
  query: string;
  engines: string[];
  totalResults: number;
  results: WebSearchResult[];
  partialFailures?: unknown[];
};

type AgentResult = {
  finalMessage: Message;
  toolCalls: Array<{ id: string; name: string; args: string; result: string }>;
  turns: number;
};

type AgentEvent =
  | { type: "step"; turn: number; message: string }
  | { type: "assistant_tool_call"; turn: number; message: Message }
  | { type: "tool_result"; turn: number; message: ToolMessage }
  | { type: "final"; turn: number; message: Message; conversation: Conversation; toolCalls: AgentResult["toolCalls"] }
  | { type: "error"; error: string };

const settings: Required<ApiConfig> = {
  baseUrl: process.env.API_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.API_KEY ?? "",
  model: process.env.API_MODEL ?? "gpt-4.1"
};

const systemPrompt = [
  "You are SuperCodex, a general office agent.",
  "Help with workplace tasks such as email, documents, research, planning, automation, meetings, operations, and cross-app workflows.",
  "Be practical, concise, and action-oriented.",
  "Use tools only when they are necessary to complete the task.",
  "Operate fully automatically within the available tools. Do not ask the user to approve routine tool use.",
  "Never delete files, wipe directories, reset repositories, format disks, escalate privileges, or perform destructive cleanup. If a requested task requires deletion, explain that it was blocked by the automatic safety policy and offer a non-destructive alternative.",
  "When browser or web tools return HTML, DOM, or raw JSON, never echo it verbatim. Extract the useful facts, page title, visible text, links, and next actions instead."
].join(" ");

const blockedCommandRules: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[;&|]\s*)rm(\s|$)/, reason: "file deletion is disabled" },
  { pattern: /\bfind\b[\s\S]*\s-delete(\s|$)/, reason: "find -delete is disabled" },
  { pattern: /\btrash\b|\btrash-put\b|\bgio\s+trash\b/, reason: "moving files to trash is disabled" },
  { pattern: /\bunlink\b/, reason: "unlink is disabled" },
  { pattern: /\brmdir\b/, reason: "directory deletion is disabled" },
  { pattern: /\brimraf\b/, reason: "recursive deletion is disabled" },
  { pattern: /\bshred\b/, reason: "secure deletion is disabled" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "destructive git reset is disabled" },
  { pattern: /\bgit\s+clean\b/, reason: "git clean deletes untracked files and is disabled" },
  { pattern: /\bgit\s+checkout\s+--\b/, reason: "discarding local changes is disabled" },
  { pattern: /\bsudo\b|\bsu\s+-?\b|\bdoas\b/, reason: "privilege escalation is disabled" },
  { pattern: />\s*\/dev\/(disk|rdisk|sda|nvme|mapper)\b/, reason: "writing to block devices is disabled" },
  { pattern: /\bmkfs(?:\.[\w-]+)?\b|\bdiskutil\s+erase|\bformat\s+[a-z]:/i, reason: "disk formatting is disabled" },
  { pattern: /\bdd\s+if=/, reason: "raw disk copy commands are disabled" },
  { pattern: /\bchmod\s+-R\s+777\b|\bchown\s+-R\b/, reason: "broad permission changes are disabled" },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, reason: "system power commands are disabled" }
];

const projects = new Map<string, Project>();
const conversations = new Map<string, Conversation>();
const skills = new Map<string, Skill>();
const automations = new Map<string, Automation>();
const attachments = new Map<string, Attachment>();
const tools = new Map<string, ToolDefinition>();
const toolHandlers = new Map<string, (args: Record<string, unknown>, context: ToolContext) => Promise<string>>();
const runningAutomations = new Set<string>();

type ToolContext = {
  workspacePath: string;
  attachments: Attachment[];
};

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
    tools: [...tools.keys()]
  });
});

app.get("/api/app", (_req, res) => {
  res.json(getAppState());
});

app.get("/api/settings", (_req, res) => {
  res.json(maskSettings());
});

app.put("/api/settings", (req, res) => {
  const body = req.body as ApiConfig;
  if (typeof body.baseUrl === "string") settings.baseUrl = body.baseUrl.trim();
  if (typeof body.apiKey === "string") settings.apiKey = body.apiKey.trim();
  if (typeof body.model === "string") settings.model = body.model.trim();
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

app.post("/api/skills/:id/connect", async (req, res) => {
  const skill = skills.get(req.params.id);
  if (!skill) {
    res.status(404).json({ error: "skill not found" });
    return;
  }

  skill.connected = true;
  await persistStore();
  res.json({ skill });
});

app.get("/api/tools", (_req, res) => {
  res.json({
    tools: getToolDefinitions().map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
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
    res.json(await openWebSearch(query, limit));
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

  const blocked = getBlockedCommandReason(command);
  if (blocked) {
    res.status(403).json({
      ok: false,
      code: 403,
      stdout: "",
      stderr: `Command blocked by SuperCodex automatic safety policy (${blocked}): ${command}`
    });
    return;
  }

  try {
    const result = await execAsync(command, {
      cwd: safeResolvePath(cwd || workspaceRoot),
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
  console.log(`Available tools: ${[...tools.keys()].join(", ")}`);
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
    attachments: conversationAttachments
  };
  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "system",
      content: `Current local project workspace: ${context.workspacePath}. File, search, coding, and test tools default to this workspace.`
    },
    {
      role: "system",
      content: formatAttachmentContext(conversationAttachments)
    },
    ...conversation.messages.map(toChatMessage)
  ];
  const toolCalls: AgentResult["toolCalls"] = [];

  for (let turns = 1; turns <= maxAgentTurns; turns++) {
    assertNotAborted(signal);
    onEvent?.({ type: "step", turn: turns, message: `第 ${turns} 步：模型正在判断是否需要调用工具。` });
    const response = await callLLM(chatMessages, config, true, signal);
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
        const result = await executeToolCall(toolCall, context);
        assertNotAborted(signal);
        toolCalls.push({
          id: toolCall.id,
          name: toolCall.function.name,
          args: toolCall.function.arguments,
          result
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
    onEvent?.({ type: "final", turn: turns, message: finalMessage, conversation, toolCalls });
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
  onEvent?.({ type: "final", turn: maxAgentTurns, message: finalMessage, conversation, toolCalls });
  return { finalMessage, toolCalls, turns: maxAgentTurns };
}

async function callLLM(messages: ChatMessage[], config?: ApiConfig, enableTools = false, signal?: AbortSignal) {
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

  const toolDefinitions = enableTools ? getToolDefinitions() : [];
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
      temperature: 0.2
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
        name: "list_directory",
        description: "List files and directories inside the workspace.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Directory path" } }
        }
      }
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
        description: "Write a text file inside the workspace.",
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
    async (args, context) => {
      const filePath = safeResolvePath(String(args.path || ""), context.workspacePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, String(args.content || ""), "utf-8");
      return `File written: ${path.relative(workspaceRoot, filePath)}`;
    }
  );

  registerTool(
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a safe shell command inside the workspace.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to run" },
            cwd: { type: "string", description: "Working directory" }
          },
          required: ["command"]
        }
      }
    },
    async (args, context) => {
      const command = String(args.command || "");
      assertCommandAllowed(command);
      const result = await execAsync(command, {
        cwd: safeResolvePath(String(args.cwd || "."), context.workspacePath),
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 5
      });
      return [result.stdout, result.stderr].filter(Boolean).join("\n") || "(Command succeeded, no output)";
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
    async (args, context) => {
      const command = String(args.command || (await inferTestCommand(context.workspacePath)));
      assertCommandAllowed(command);
      try {
        const result = await execAsync(command, {
          cwd: context.workspacePath,
          timeout: 120_000,
          maxBuffer: 1024 * 1024 * 5
        });
        return [result.stdout, result.stderr].filter(Boolean).join("\n") || "(Tests completed, no output)";
      } catch (error) {
        const err = error as Error & { stdout?: string; stderr?: string; code?: number };
        return [
          `Command failed (${err.code ?? 1}): ${command}`,
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
    async (args, context) => {
      const attachment = findContextAttachment(context, String(args.attachmentId || ""));
      if (!attachment) throw new Error("Attachment not found in this conversation");
      if (attachment.kind !== "image") throw new Error("Attachment is not an image");

      const format = normalizeImageFormat(String(args.format || path.extname(attachment.originalName).slice(1) || "png"));
      const outputName =
        sanitizeFileName(String(args.outputName || "")) ||
        `${path.parse(attachment.originalName).name}-edited.${format === "jpeg" ? "jpg" : format}`;
      const conversation = conversations.get(attachment.conversationId);
      const artifactDir = conversation ? path.join(getConversationDir(conversation), "artifacts") : path.dirname(attachment.path);
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
            num: { type: "number", description: "Number of results" }
          },
          required: ["query"]
        }
      }
    },
    async (args) => {
      const query = String(args.query || "");
      const num = Math.max(1, Math.min(Number(args.num) || 5, 8));
      const payload = await openWebSearch(query, num);
      if (!payload.results.length) return "No results found.";
      return payload.results
        .map((result, index) =>
          [
            `${index + 1}. ${result.title}`,
            `URL: ${result.url}`,
            result.description ? `Description: ${result.description}` : "",
            result.engine ? `Engine: ${result.engine}` : ""
          ].filter(Boolean).join("\n")
        )
        .join("\n\n");
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
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<string>
) {
  tools.set(definition.function.name, definition);
  toolHandlers.set(definition.function.name, handler);
}

function getToolDefinitions() {
  return [...tools.values()];
}

async function executeToolCall(toolCall: ToolCall, context: ToolContext) {
  const handler = toolHandlers.get(toolCall.function.name);
  if (!handler) return `Unknown tool: ${toolCall.function.name}`;
  try {
    const args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
    return sanitizeToolResult(toolCall.function.name, await handler(args, context));
  } catch (error) {
    return `Tool error: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

function sanitizeToolResult(toolName: string, result: string) {
  if (!looksLikeHtml(result)) return result;
  return [
    `${toolName} returned HTML-like content. SuperCodex extracted readable text instead of raw markup.`,
    htmlToReadableText(result)
  ].join("\n");
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

function parseAutomationInput(input: {
  title?: string;
  schedule?: string;
  prompt?: string;
  instruction?: string;
}) {
  const instruction = normalizeWhitespace(input.instruction || "");
  const schedule = normalizeScheduleText(input.schedule || extractScheduleText(instruction));
  const prompt = normalizeWhitespace(input.prompt || extractAutomationPrompt(instruction, schedule) || instruction || input.title || "执行这个定时任务。");
  return {
    title: normalizeWhitespace(input.title || titleFromPrompt(prompt || instruction || "新自动化")),
    schedule: schedule || "手动触发",
    prompt
  };
}

function extractScheduleText(instruction: string) {
  const interval = instruction.match(/每\s*(\d+)\s*(?:h|H|小时|个小时)/);
  if (interval) return `每${interval[1]}小时`;
  if (/每\s*(?:天|日)|每天|每日/.test(instruction)) {
    const time = extractTimeOfDay(instruction);
    if (time) return `每天 ${time}`;
  }
  if (/下班前|下班之前/.test(instruction)) return "每天 17:30";
  const time = extractTimeOfDay(instruction);
  return time ? `每天 ${time}` : "";
}

function extractAutomationPrompt(instruction: string, schedule: string) {
  if (!instruction) return "";
  let prompt = instruction;
  prompt = prompt.replace(/每\s*(\d+)\s*(?:h|H|小时|个小时)/g, "");
  prompt = prompt.replace(/每天|每日|每日上午|每天上午|每天早上|每天中午|每天下午|每天晚上|每天早晨|每天下午|每晚/g, "");
  prompt = prompt.replace(/凌晨|早上|早晨|上午|中午|下午|晚上|晚间|夜里/g, "");
  prompt = prompt.replace(/下班前|下班之前/g, "");
  if (schedule) {
    const time = schedule.match(/\d{1,2}:\d{2}/)?.[0];
    if (time) {
      const [hour, minute] = time.split(":").map(Number);
      prompt = prompt
        .replace(new RegExp(`${hour}\\s*[:：]\\s*${minute.toString().padStart(2, "0")}`), "")
        .replace(new RegExp(`${hour}\\s*点\\s*${minute ? `${minute}\\s*分?` : ""}`), "");
    }
  }
  return normalizeWhitespace(prompt.replace(/^(提醒|返回|推送|生成|完成)?/, "$1").replace(/[，,。；;]\s*$/, "")) || instruction;
}

function normalizeScheduleText(value: string) {
  const text = normalizeWhitespace(value);
  if (!text) return "";
  const interval = text.match(/每\s*(\d+)\s*(?:h|H|小时|个小时)/);
  if (interval) return `每${Math.max(1, Number(interval[1]))}小时`;
  if (/下班前|下班之前/.test(text)) return "每天 17:30";
  const time = extractTimeOfDay(text);
  if (time) return `每天 ${time}`;
  if (/手动/.test(text)) return "手动触发";
  return text;
}

function extractTimeOfDay(text: string) {
  const colon = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (colon) return formatTime(Number(colon[1]), Number(colon[2]));
  const chinese = text.match(/(?:(凌晨|早上|早晨|上午|中午|下午|晚上|晚间|夜里)\s*)?(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分?)?/);
  if (!chinese) return "";
  let hour = Number(chinese[2]);
  const minute = Number(chinese[3] || 0);
  const period = chinese[1] || "";
  if ((period === "下午" || period === "晚上" || period === "晚间" || period === "夜里") && hour < 12) hour += 12;
  if (period === "中午" && hour < 11) hour += 12;
  return formatTime(hour, minute);
}

function formatTime(hour: number, minute: number) {
  const safeHour = Math.max(0, Math.min(23, hour));
  const safeMinute = Math.max(0, Math.min(59, minute));
  return `${safeHour.toString().padStart(2, "0")}:${safeMinute.toString().padStart(2, "0")}`;
}

function computeNextRunAt(schedule: string, from = new Date()) {
  const normalized = normalizeScheduleText(schedule);
  if (!normalized || normalized === "手动触发") return undefined;
  const interval = normalized.match(/^每(\d+)小时$/);
  if (interval) {
    return new Date(from.getTime() + Math.max(1, Number(interval[1])) * 60 * 60 * 1000).toISOString();
  }
  const daily = normalized.match(/^每天\s+(\d{1,2}):(\d{2})$/);
  if (daily) {
    const next = new Date(from);
    next.setHours(Number(daily[1]), Number(daily[2]), 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  return undefined;
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
  const artifactDir = path.join(getConversationDir(conversation), "artifacts");
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
  [
    ["messages", "连接消息传送", "从团队讨论中获取背景信息", "slack", "@slack/web-api"],
    ["email", "连接电子邮件", "总结邮件、起草回复和跟进请求", "mail", "nodemailer"],
    ["files", "连接文件", "审查报告、研究资料和计划", "drive", "@googleapis/drive"],
    ["webbridge", "Kimi WebBridge", "控制真实浏览器、读取网页、截图和跨站操作", "webbridge", ""]
  ].forEach(([skillId, title, description, accent, npmPackage]) => {
    skills.set(skillId, {
      id: skillId,
      title,
      description,
      accent,
      npmPackage: npmPackage || undefined,
      connected: existing.get(skillId)?.connected ?? false,
      installed: skillId === "webbridge" ? true : existing.get(skillId)?.installed ?? false
    });
  });
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
    tools: [...tools.keys()]
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

function toChatMessage(message: StoredMessage): ChatMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.tool_call_id,
      name: message.toolName
    };
  }
  return {
    role: message.role,
    content:
      message.attachments?.length
        ? `${message.content}\n\nAttached files:\n${message.attachments
            .map((attachment) =>
              `${attachment.id}: ${attachment.originalName} (${attachment.kind}, ${attachment.mimeType}, ${attachment.size} bytes, ${attachment.url})`
            )
            .join("\n")}`
        : message.content || null,
    tool_calls: message.tool_calls
  };
}

function safeResolvePath(inputPath: string, basePath = workspaceRoot) {
  const base = path.resolve(basePath);
  const resolved = path.resolve(base, inputPath || ".");
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Path is outside workspace: ${inputPath}`);
  }
  return resolved;
}

function sanitizeFileName(value: string) {
  return path
    .basename(value)
    .replace(/[^\p{L}\p{N}_.-]+/gu, "_")
    .replace(/^_+/, "")
    .slice(0, 160) || "attachment";
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

function normalizeLocalPath(inputPath: string) {
  const home = process.env.HOME || "";
  const expanded =
    inputPath === "~" || inputPath.startsWith(`~${path.sep}`)
      ? path.join(home, inputPath.slice(2))
      : inputPath;
  return path.resolve(expanded);
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

function assertCommandAllowed(command: string) {
  const blocked = getBlockedCommandReason(command);
  if (blocked) {
    throw new Error(`Command blocked by SuperCodex automatic safety policy (${blocked}): ${command}`);
  }
}

function getBlockedCommandReason(command: string) {
  const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
  return blockedCommandRules.find((rule) => rule.pattern.test(normalized))?.reason || "";
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

function formatFetchedPage(url: string, html: string) {
  const title = extractTagContent(html, "title");
  const description = extractMetaDescription(html);
  const text = htmlToReadableText(html);
  return [
    `Fetched page: ${url}`,
    title ? `Title: ${title}` : "",
    description ? `Description: ${description}` : "",
    "Readable text:",
    text || "(No readable text extracted.)"
  ]
    .filter(Boolean)
    .join("\n");
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

function htmlToReadableText(html: string) {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutScripts
    .replace(/<\/(p|div|section|article|header|footer|main|aside|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "));
  return normalizeWhitespace(text).slice(0, 8000);
}

function extractTagContent(html: string, tagName: string) {
  const match = html.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? normalizeWhitespace(decodeHtmlEntities(match[1].replace(/<[^>]+>/g, " "))).slice(0, 300) : "";
}

function extractMetaDescription(html: string) {
  const match =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i);
  return match ? normalizeWhitespace(decodeHtmlEntities(match[1])).slice(0, 500) : "";
}

function looksLikeHtml(text: string) {
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>]|<div[\s>]|<meta[\s>]/i.test(text);
}

function compactJsonText(text: string, limit: number) {
  try {
    return JSON.stringify(cleanWebPayload(JSON.parse(text)), null, 2).slice(0, limit);
  } catch {
    return normalizeWhitespace(text).slice(0, limit);
  }
}

function normalizeWhitespace(text: string) {
  return text
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(text: string) {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " "
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity: string) => {
    if (entity[0] === "#") {
      const codePoint = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : full;
    }
    return entities[entity.toLowerCase()] ?? full;
  });
}

function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

async function openWebSearch(query: string, limit: number): Promise<WebSearchPayload> {
  const binPath = path.join(workspaceRoot, "node_modules", ".bin", "open-websearch");
  const { stdout, stderr } = await execFileAsync(
    binPath,
    ["search", query, "--limit", String(Math.max(1, Math.min(limit, 8))), "--json"],
    {
      cwd: workspaceRoot,
      timeout: 45_000,
      maxBuffer: 1024 * 1024 * 4,
      env: {
        ...process.env,
        OPEN_WEBSEARCH_DAEMON_ACTION_TIMEOUT_MS: "20000"
      }
    }
  );
  const envelope = parseOpenWebSearchJson(stdout || stderr);
  if (envelope.status !== "ok") {
    throw new Error(envelope.error?.message ?? "open-websearch failed");
  }
  return envelope.data as WebSearchPayload;
}

function parseOpenWebSearchJson(output: string) {
  const start = output.lastIndexOf("\n{");
  const jsonText = (start >= 0 ? output.slice(start + 1) : output.slice(output.indexOf("{"))).trim();
  if (!jsonText) throw new Error("open-websearch returned no JSON");
  return JSON.parse(jsonText) as {
    status: "ok" | "error";
    data: unknown;
    error?: { message?: string };
  };
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

function titleFromPrompt(prompt: string) {
  return prompt.length > 22 ? `${prompt.slice(0, 22)}...` : prompt;
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
