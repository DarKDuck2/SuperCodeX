import type express from "express";
import type multer from "multer";
import { promises as fs } from "node:fs";
import path from "node:path";
import { computeNextRunAt, normalizeScheduleText, parseAutomationInput } from "../automation/schedule.js";
import { getFileResponseMetadata, openLocalFile } from "../core/local-files.js";
import { normalizeLocalPath, safeResolvePath } from "../core/paths.js";
import { normalizeDeliveryMode } from "../agent/spec.js";
import { executeStructuredCommand, normalizeCommandInput } from "../tools/command.js";
import { openWebSearch } from "../web/search.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import type {
  AgentEvent,
  AgentResult,
  AgentRunMode,
  AgentRunOptions,
  ApiConfig,
  Attachment,
  Automation,
  AutomationRun,
  ChatCompletionResponse,
  ChatMessage,
  Conversation,
  Message,
  Project,
  ProjectTreeNode,
  PublicAttachment,
  Skill
} from "../domain/types.js";

type RegisterApiRoutesDependencies = {
  settings: Required<ApiConfig>;
  workspaceRoot: string;
  upload: multer.Multer;
  projects: Map<string, Project>;
  conversations: Map<string, Conversation>;
  skills: Map<string, Skill>;
  automations: Map<string, Automation>;
  attachments: Map<string, Attachment>;
  runningAutomations: Set<string>;
  toolRegistry: ToolRegistry;
  getAppState: () => unknown;
  maskSettings: () => unknown;
  persistStore: () => Promise<void>;
  createProject: (name: string, rootPath?: string) => Project;
  createConversation: (projectId: string, title: string, shortcut?: string) => Conversation;
  createAutomationConversation: (title: string) => Conversation;
  listProjectTree: (rootPath: string, maxDepth: number) => Promise<ProjectTreeNode[]>;
  saveAttachment: (conversationId: string, file: Express.Multer.File) => Promise<Attachment>;
  publicAttachment: (attachment: Attachment) => PublicAttachment;
  resolveConversationAttachments: (conversationId: string, attachmentIds?: string[]) => PublicAttachment[];
  normalizeAgentRunMode: (mode: unknown) => AgentRunMode;
  generateConversationTitle: (prompt: string, config?: ApiConfig) => Promise<string>;
  summarizeConversation: (conversation: Conversation) => string;
  isGenericConversationTitle: (title: string) => boolean;
  isGenericConversationFolder: (folderName?: string) => boolean;
  conversationFolderName: (title: string) => string;
  runAgentLoop: (
    conversation: Conversation,
    config?: ApiConfig,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
    mode?: AgentRunMode,
    options?: AgentRunOptions
  ) => Promise<AgentResult>;
  writeAgentEvent: (res: express.Response, event: AgentEvent) => void;
  callLLM: (messages: ChatMessage[], config?: ApiConfig, enableTools?: boolean) => Promise<ChatCompletionResponse>;
  getToolDefinitions: () => ToolDefinition[];
  searchSkillCatalog: (query: string) => unknown[];
  loadSkillById: (skillId: string, source?: Skill["source"]) => Skill | undefined;
  loadExternalSkill: (input: Record<string, unknown>) => Promise<Skill>;
  getWebBridgeStatus: () => Promise<unknown>;
  runAutomation: (automation: Automation, trigger?: AutomationRun["trigger"]) => Promise<void>;
  id: (prefix: string) => string;
  now: () => string;
};

export function registerApiRoutes(app: express.Express, deps: RegisterApiRoutesDependencies) {
  const {
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
  } = deps;

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
    const { content, config, attachmentIds, stream, mode, deliveryMode } = req.body as {
      content?: string;
      config?: ApiConfig;
      attachmentIds?: string[];
      stream?: boolean;
      mode?: AgentRunMode;
      deliveryMode?: AgentRunOptions["deliveryMode"];
    };
    const prompt = content?.trim();
    const runMode = normalizeAgentRunMode(mode);
    const runOptions: AgentRunOptions = { deliveryMode: normalizeDeliveryMode(deliveryMode) };
  
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
        await runAgentLoop(
          conversation,
          config,
          (event) => writeAgentEvent(res, event),
          streamAbortController.signal,
          runMode,
          runOptions
        );
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
      const agentResult = await runAgentLoop(conversation, config, undefined, undefined, runMode, runOptions);
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
}
