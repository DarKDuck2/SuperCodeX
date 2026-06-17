import { promises as fs } from "node:fs";
import path from "node:path";
import { computeNextRunAt, normalizeScheduleText } from "../automation/schedule.js";
import { findContextAttachment } from "../attachments/office.js";
import { inferAttachmentKind } from "../core/local-files.js";
import { sanitizeFileName } from "../core/paths.js";
import { normalizeWhitespace, titleFromPrompt } from "../core/text.js";
import { builtinSkillCatalog } from "../skills/catalog.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type {
  ApiConfig,
  Attachment,
  Automation,
  ChatCompletionResponse,
  ChatMessage,
  Conversation,
  Message,
  Project,
  ProjectTreeNode,
  PublicAttachment,
  Skill,
  Store,
  StoredMessage
} from "../domain/types.js";

type CreateStateServiceDependencies = {
  settings: Required<ApiConfig>;
  workspaceRoot: string;
  workspaceFilesDirName: string;
  dataDir: string;
  dataFile: string;
  conversationsDir: string;
  projects: Map<string, Project>;
  conversations: Map<string, Conversation>;
  skills: Map<string, Skill>;
  automations: Map<string, Automation>;
  attachments: Map<string, Attachment>;
  toolRegistry: ToolRegistry;
  maxContextToolChars: number;
  maxContextMessageChars: number;
  callLLM: (messages: ChatMessage[], config?: ApiConfig, enableTools?: boolean) => Promise<ChatCompletionResponse>;
  normalizeSkill: (skill: Skill) => Skill;
  createAutomationConversation: (title: string) => Conversation;
  maskSettings: () => unknown;
  id: (prefix: string) => string;
  now: () => string;
};

export function createStateService(deps: CreateStateServiceDependencies) {
  const {
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
  } = deps;

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

  return {
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
  };
}
