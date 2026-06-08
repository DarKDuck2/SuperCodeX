import {
  AlarmClock,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Clipboard,
  Download,
  FileText,
  Folder,
  Globe2,
  Grid3X3,
  Image as ImageIcon,
  KeyRound,
  Mail,
  MessageCircle,
  Mic,
  PanelLeft,
  Paperclip,
  PenLine,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Slack,
  Sparkles,
  Trash2,
  UserRound,
  X,
  Wrench,
  Workflow
} from "lucide-react";
import { ClipboardEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

type Role = "system" | "user" | "assistant" | "tool";

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type Message = {
  id: string;
  role: Exclude<Role, "system" | "tool">;
  content: string;
  tool_calls?: ToolCall[];
  attachments?: Attachment[];
  createdAt?: string;
  status?: "thinking" | "done" | "error";
};

type ToolMessage = {
  id: string;
  role: "tool";
  content: string;
  tool_call_id: string;
  toolName?: string;
  createdAt?: string;
};

type StoredMessage = Message | ToolMessage;

type ApiSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

type Project = {
  id: string;
  name: string;
  rootPath?: string;
  conversations: ConversationSummary[];
};

type ConversationSummary = {
  id: string;
  title: string;
  shortcut?: string;
  updatedAt?: string;
  messageCount?: number;
};

type Skill = {
  id: "messages" | "email" | "files" | "webbridge";
  title: string;
  description: string;
  accent: "slack" | "mail" | "drive" | "webbridge";
  connected: boolean;
  installed?: boolean;
};

type AppState = {
  settings: ApiSettings & { configured?: boolean };
  projects: Project[];
  skills: Skill[];
  automations: Array<{
    id: string;
    title: string;
    schedule: string;
    enabled: boolean;
  }>;
};

type Automation = AppState["automations"][number];
type SearchResult = {
  id: string;
  title: string;
  projectId: string;
  type: string;
};
type WebBridgeStatus = {
  running: boolean;
  extension_connected: boolean;
  port: number;
  version: string;
  extension_version?: string;
};

type AgentStreamEvent =
  | { type: "step"; turn: number; message: string }
  | { type: "assistant_tool_call"; turn: number; message: Message }
  | { type: "tool_result"; turn: number; message: ToolMessage }
  | {
      type: "final";
      turn: number;
      message: Message;
      conversation: { messages: StoredMessage[] };
      toolCalls: unknown[];
    }
  | { type: "error"; error: string };
type ProjectTreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: ProjectTreeNode[];
};

type Attachment = {
  id: string;
  conversationId: string;
  originalName: string;
  mimeType: string;
  size: number;
  kind: "image" | "text" | "file";
  createdAt: string;
  url: string;
  derivedFrom?: string;
};

type Artifact = {
  id: string;
  title: string;
  description: string;
  href: string;
  kind: "image" | "file";
};

const defaultSettings: ApiSettings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1"
};

const skillIcons = {
  messages: Slack,
  email: Mail,
  files: FileText,
  webbridge: Globe2
};

function App() {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [input, setInput] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [settings, setSettings] = useState<ApiSettings>(defaultSettings);
  const [isWorking, setIsWorking] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [permission, setPermission] = useState("全部允许");
  const [mode, setMode] = useState<"agent" | "team">("agent");
  const [activeView, setActiveView] = useState<"home" | "skills" | "automations" | "search" | "webbridge">("home");
  const [appError, setAppError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [webBridgeStatus, setWebBridgeStatus] = useState<WebBridgeStatus | null>(null);
  const [showProjectLoader, setShowProjectLoader] = useState(false);
  const [projectPath, setProjectPath] = useState("/Users/a1021500689/Documents/SuperCodex");
  const [projectTree, setProjectTree] = useState<ProjectTreeNode[]>([]);
  const [activeWorkspaceName, setActiveWorkspaceName] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const messageStackRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const hasConversation = messages.length > 0;
  const activeProject = useMemo(
    () =>
      projects.find((project) =>
        project.conversations.some((conversation) => conversation.id === activeConversationId)
      ) ??
      projects.find((project) => project.rootPath) ??
      projects[0],
    [activeConversationId, projects]
  );
  const historyItems = useMemo(
    () =>
      projects
        .flatMap((project) =>
          project.conversations.map((conversation) => ({
            ...conversation,
            projectName: project.name
          }))
        )
        .filter(
          (conversation) =>
            (conversation.messageCount ?? 0) > 0 &&
            conversation.title !== "暂无对话" &&
            conversation.title !== "新任务"
        )
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")),
    [projects]
  );
  const promptTitle = useMemo(
    () => (hasConversation ? "SuperCodex" : "让 SuperCodex 帮你完成任务"),
    [hasConversation]
  );
  const visibleProjectTree = useMemo(() => flattenProjectTree(projectTree).slice(0, 10), [projectTree]);
  const artifacts = useMemo(() => extractArtifacts(messages), [messages]);

  useEffect(() => {
    loadAppState();
  }, []);

  useEffect(() => {
    messageStackRef.current?.scrollTo({
      top: messageStackRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages.length, isWorking]);

  async function loadAppState() {
    try {
      setIsBooting(true);
      setAppError("");
      const payload = await syncAppState();
      const firstConversation = payload.projects[0]?.conversations[0];
      if (firstConversation) {
        setActiveConversationId(firstConversation.id);
        await loadMessages(firstConversation.id);
      }
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "应用加载失败");
    } finally {
      setIsBooting(false);
    }
  }

  async function syncAppState() {
    const response = await fetch("/api/app");
    if (!response.ok) throw new Error("无法连接后端 /api/app");
    const payload = (await response.json()) as AppState;
    setProjects(payload.projects);
    setSkills(payload.skills);
    setAutomations(payload.automations);
    setSettings({
      baseUrl: payload.settings.baseUrl || defaultSettings.baseUrl,
      apiKey: payload.settings.apiKey === "********" ? "" : payload.settings.apiKey,
      model: payload.settings.model || defaultSettings.model
    });
    return payload;
  }

  async function loadMessages(conversationId: string) {
    setActiveView("home");
    setActiveConversationId(conversationId);
    const response = await fetch(`/api/conversations/${conversationId}/messages`);
    if (!response.ok) throw new Error("无法加载会话消息");
    const payload = (await response.json()) as { messages: StoredMessage[] };
    setMessages(payload.messages);
  }

  async function createTask() {
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: activeProject?.id,
        title: "新任务"
      })
    });
    const conversation = (await response.json()) as ConversationSummary;
    await syncAppState();
    await loadMessages(conversation.id);
    setPendingAttachments([]);
  }

  async function ensureConversation(title = "新任务") {
    if (activeConversationId) return activeConversationId;
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: activeProject?.id,
        title
      })
    });
    if (!response.ok) throw new Error("无法创建会话");
    const conversation = (await response.json()) as ConversationSummary;
    await syncAppState();
    setActiveConversationId(conversation.id);
    return conversation.id;
  }

  async function saveSettings(nextSettings = settings) {
    const body: ApiSettings | Omit<ApiSettings, "apiKey"> = nextSettings.apiKey
      ? nextSettings
      : {
          baseUrl: nextSettings.baseUrl,
          model: nextSettings.model
        };
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = (await response.json()) as ApiSettings;
    setSettings({
      baseUrl: payload.baseUrl || nextSettings.baseUrl,
      apiKey: nextSettings.apiKey,
      model: payload.model || nextSettings.model
    });
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const prompt = input.trim();
    if ((!prompt && pendingAttachments.length === 0) || isWorking) return;

    let conversationId = activeConversationId;
    if (!conversationId) {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: activeProject?.id, title: titleFromPrompt(prompt) })
      });
      const conversation = (await response.json()) as ConversationSummary;
      conversationId = conversation.id;
      setActiveConversationId(conversationId);
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt || "请处理这些附件。",
      attachments: pendingAttachments,
      createdAt: new Date().toISOString()
    };
    const pendingId = crypto.randomUUID();

    setInput("");
    setPendingAttachments([]);
    setMessages((current) => [
      ...current,
      userMessage,
      {
        id: pendingId,
        role: "assistant",
        status: "thinking",
        createdAt: new Date().toISOString(),
        content: "Agent 正在思考并调用工具..."
      }
    ]);
    setIsWorking(true);

    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: settings.apiKey ? settings : undefined,
          content: prompt || "请处理这些附件。",
          attachmentIds: pendingAttachments.map((attachment) => attachment.id),
          stream: true
        })
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({ error: "请求失败" }));
        throw new Error(payload.error ?? "请求失败");
      }
      await readAgentStream(response, pendingId);
      await syncAppState();
      setActiveConversationId(conversationId);
    } catch (error) {
      setMessages((current) =>
        current.map((message) =>
          message.id === pendingId
            ? {
                ...message,
                status: "error",
                content:
                  error instanceof Error
                    ? `调用失败：${error.message}`
                    : "调用失败：未知错误"
              }
            : message
        )
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function readAgentStream(response: Response, pendingId: string) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        const line = chunk
          .split("\n")
          .find((part) => part.startsWith("data:"))
          ?.replace(/^data:\s*/, "");
        if (!line || line === "[DONE]") continue;
        handleAgentEvent(JSON.parse(line) as AgentStreamEvent, pendingId);
      }
    }
  }

  function handleAgentEvent(event: AgentStreamEvent, pendingId: string) {
    if (event.type === "step") {
      setMessages((current) =>
        current.map((message) =>
          message.id === pendingId
            ? {
                ...message,
                content: event.message
              }
            : message
        )
      );
      return;
    }

    if (event.type === "assistant_tool_call") {
      setMessages((current) => upsertStreamMessage(removeMessage(current, pendingId), event.message));
      return;
    }

    if (event.type === "tool_result") {
      setMessages((current) => upsertStreamMessage(removeMessage(current, pendingId), event.message));
      return;
    }

    if (event.type === "final") {
      setMessages(event.conversation.messages);
      return;
    }

    if (event.type === "error") {
      throw new Error(event.error);
    }
  }

  function useSkillPrompt(title: string) {
    const prompts: Record<string, string> = {
      连接消息传送: "帮我从团队聊天记录中提取项目背景、待办事项和风险。",
      连接电子邮件: "帮我总结最近邮件中的重要请求，并起草需要回复的内容。",
      连接文件: "帮我审查这份文件，提炼结论、行动项和需要补充的信息。",
      "Kimi WebBridge": "检查 Kimi WebBridge 状态，并准备用真实浏览器处理网页任务。"
    };
    setInput(prompts[title] ?? title);
  }

  async function connectSkill(skillId: Skill["id"], title: string) {
    await fetch(`/api/skills/${skillId}/connect`, { method: "POST" });
    setSkills((current) =>
      current.map((skill) => (skill.id === skillId ? { ...skill, connected: true } : skill))
    );
    useSkillPrompt(title);
  }

  async function createAutomation() {
    const title = input.trim() || "跟进当前任务";
    await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, schedule: "每天 09:00" })
    });
    setInput(`创建一个每天 09:00 自动执行的任务：${title}`);
    await syncAppState();
    setActiveView("automations");
  }

  async function toggleAutomation(automation: Automation) {
    const response = await fetch(`/api/automations/${automation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !automation.enabled })
    });
    if (!response.ok) throw new Error("更新自动化失败");
    await syncAppState();
  }

  async function deleteAutomation(id: string) {
    const response = await fetch(`/api/automations/${id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 204) throw new Error("删除自动化失败");
    await syncAppState();
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error("搜索失败");
    const payload = (await response.json()) as { results: SearchResult[] };
    setSearchResults(payload.results);
  }

  async function refreshWebBridgeStatus() {
    try {
      const response = await fetch("/api/webbridge/status");
      if (!response.ok) throw new Error("WebBridge 状态读取失败");
      setWebBridgeStatus((await response.json()) as WebBridgeStatus);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "WebBridge 状态读取失败");
    }
  }

  async function loadLocalProject(event: FormEvent) {
    event.preventDefault();
    try {
      setAppError("");
      const response = await fetch("/api/workspaces/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: projectPath })
      });
      const payload = (await response.json()) as {
        project?: Project;
        conversation?: ConversationSummary;
        tree?: ProjectTreeNode[];
        error?: string;
      };
      if (!response.ok || !payload.project || !payload.conversation) {
        throw new Error(payload.error || "加载本地项目失败");
      }
      setProjectTree(payload.tree || []);
      setActiveWorkspaceName(payload.project.name);
      setShowProjectLoader(false);
      await syncAppState();
      await loadMessages(payload.conversation.id);
      setInput(`已进入本地项目 ${payload.project.name}。请先分析项目结构，并告诉我可以如何开始改动。`);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "加载本地项目失败");
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const selectedFiles = Array.from(files).filter((file) => file.size > 0);
    if (!selectedFiles.length) return;
    try {
      setAppError("");
      const conversationId = await ensureConversation("附件任务");
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append("files", file));
      const response = await fetch(`/api/conversations/${conversationId}/attachments`, {
        method: "POST",
        body: formData
      });
      const payload = (await response.json()) as { attachments?: Attachment[]; error?: string };
      if (!response.ok || !payload.attachments) throw new Error(payload.error || "附件上传失败");
      setPendingAttachments((current) => [...current, ...payload.attachments!]);
      setInput((current) =>
        current.trim()
          ? current
          : payload.attachments!.some((attachment) => attachment.kind === "image")
            ? "请查看这些图片，并根据我的要求进行修改。"
            : "请读取这些文件，并根据我的要求进行处理。"
      );
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "附件上传失败");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files || []);
    if (files.length > 0) {
      void uploadFiles(files);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <main className={`appShell ${isSidebarCollapsed ? "sidebarCollapsed" : ""}`}>
      <aside className="sideRail">
        <div className="windowChrome">
          <button
            className={`sidebarIconButton ${activeView === "search" ? "active" : ""}`}
            type="button"
            title="搜索"
            onClick={() => setActiveView("search")}
          >
            <Search size={18} />
          </button>
          <button
            className="sidebarIconButton sidebarToggle"
            type="button"
            title={isSidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            onClick={() => setIsSidebarCollapsed((value) => !value)}
          >
            <PanelLeft size={18} />
          </button>
        </div>

        <div className="sideBrand">
          <div className="sideBrandMark">
            <Bot size={18} />
          </div>
          <div className="sideBrandText">
            <strong>SuperCodex</strong>
            <span>通用办公 Agent</span>
          </div>
        </div>

        <nav className="primaryNav">
          <button
            className={`navButton ${activeView === "home" ? "active" : ""}`}
            type="button"
            onClick={createTask}
          >
            <PenLine size={19} />
            <span className="navText">新建任务</span>
            <kbd>⌘ K</kbd>
          </button>
          <button
            className={`navButton ${activeView === "skills" ? "active" : ""}`}
            type="button"
            onClick={() => setActiveView("skills")}
          >
            <Grid3X3 size={19} />
            <span className="navText">技能</span>
          </button>
          <button
            className={`navButton ${activeView === "automations" ? "active" : ""}`}
            type="button"
            onClick={() => setActiveView("automations")}
          >
            <AlarmClock size={19} />
            <span className="navText">定时任务</span>
          </button>
          <button
            className={`navButton ${activeView === "webbridge" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveView("webbridge");
              refreshWebBridgeStatus();
            }}
          >
            <Globe2 size={19} />
            <span className="navText">WebBridge</span>
          </button>
        </nav>

        <section className="sideSection">
          <div className="sideLabel">历史记录</div>
          <div className="historyList">
            {historyItems.length === 0 ? (
              <p className="sideHint">暂无历史对话</p>
            ) : (
              historyItems.map((conversation) => (
                <button
                  className={`conversationItem ${
                    conversation.id === activeConversationId ? "active" : ""
                  }`}
                  type="button"
                  key={conversation.id}
                  onClick={() => loadMessages(conversation.id)}
                >
                  <span>
                    <strong>{conversation.title}</strong>
                    <small>{conversation.projectName}</small>
                  </span>
                </button>
              ))
            )}
          </div>
        </section>
      </aside>

      <section className="mainStage">
        <header className="stageTop">
          <div className="stageActions">
            <button
              className={`plainButton ${showSettings ? "active" : ""}`}
              type="button"
              onClick={() => setShowSettings((value) => !value)}
            >
              <Settings2 size={17} />
              API
            </button>
          </div>
        </header>

        {appError && (
          <div className="appBanner" role="alert">
            {appError}
          </div>
        )}

        {showSettings && (
          <section className="settingsDock" aria-label="API 设置">
            <label className="field">
              <span>Base URL</span>
              <input
                value={settings.baseUrl}
                onBlur={() => saveSettings()}
                onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </label>
            <label className="field">
              <span>API Key</span>
              <div className="secretInput">
                <KeyRound size={16} />
                <input
                  type="password"
                  value={settings.apiKey}
                  onBlur={() => saveSettings()}
                  onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })}
                  placeholder="只保存在当前页面状态"
                />
              </div>
            </label>
            <label className="field">
              <span>Model</span>
              <input
                value={settings.model}
                onBlur={() => saveSettings()}
                onChange={(event) => setSettings({ ...settings, model: event.target.value })}
                placeholder="gpt-4.1 / deepseek-chat / ..."
              />
            </label>
          </section>
        )}

        <div className={`heroWork ${hasConversation || activeView !== "home" ? "withMessages" : ""}`}>
          <section className="conversationPane">
            {(activeView !== "home" || !hasConversation) && (
              <div className="titleBlock">
                {activeView === "home" && (
                  <div className="productMark">
                    <Bot size={28} />
                    <span>Agent</span>
                  </div>
                )}
                <h1>
                  {activeView === "skills"
                    ? "连接 Agent 能力"
                    : activeView === "automations"
                      ? "定时任务"
                      : activeView === "search"
                        ? "搜索对话和项目"
                        : activeView === "webbridge"
                          ? "Kimi WebBridge"
                          : promptTitle}
                </h1>
                {activeView === "home" && !hasConversation && (
                  <p>研究、邮件、文档、表格、自动化和跨应用流程，都可以从这里开始。</p>
                )}
              </div>
            )}

            {activeView === "search" && (
              <section className="utilityPanel">
                <form className="searchForm" onSubmit={runSearch}>
                  <Search size={18} />
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="搜索对话标题、项目任务..."
                  />
                  <button type="submit">搜索</button>
                </form>
                <div className="utilityList">
                  {searchResults.length === 0 ? (
                    <p className="emptyText">输入关键词后搜索历史对话。</p>
                  ) : (
                    searchResults.map((result) => (
                      <button
                        className="utilityRow"
                        type="button"
                        key={result.id}
                        onClick={() => loadMessages(result.id)}
                      >
                        <MessageCircle size={17} />
                        <span>{result.title}</span>
                      </button>
                    ))
                  )}
                </div>
              </section>
            )}

            {activeView === "skills" && (
              <div className="skillCards alwaysVisible">
                {skills.map((skill) => {
                  const Icon = skillIcons[skill.id];
                  return (
                    <button
                      className="skillCard"
                      type="button"
                      key={skill.id}
                      onClick={() => connectSkill(skill.id, skill.title)}
                    >
                      <span className={`skillIcon ${skill.accent}`}>
                        <Icon size={22} />
                      </span>
                      <strong>{skill.title}</strong>
                      <small>
                        {skill.connected
                          ? "已连接，可以用于当前任务"
                          : skill.installed
                            ? `${skill.description}，已安装`
                            : skill.description}
                      </small>
                    </button>
                  );
                })}
              </div>
            )}

            {activeView === "automations" && (
              <section className="utilityPanel">
                <div className="utilityList">
                  {automations.length === 0 ? (
                    <p className="emptyText">还没有定时任务。可以在输入框写下任务后点击“创建自动化”。</p>
                  ) : (
                    automations.map((automation) => (
                      <div className="utilityRow automationRow" key={automation.id}>
                        <Workflow size={17} />
                        <span>
                          <strong>{automation.title}</strong>
                          <small>{automation.schedule}</small>
                        </span>
                        <button type="button" onClick={() => toggleAutomation(automation)}>
                          {automation.enabled ? "停用" : "启用"}
                        </button>
                        <button type="button" title="删除" onClick={() => deleteAutomation(automation.id)}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>
            )}

            {activeView === "webbridge" && (
              <section className="utilityPanel statusPanel">
                <div className="statusGrid">
                  <div>
                    <span>Daemon</span>
                    <strong>{webBridgeStatus?.running ? "运行中" : "未运行"}</strong>
                  </div>
                  <div>
                    <span>浏览器扩展</span>
                    <strong>{webBridgeStatus?.extension_connected ? "已连接" : "未连接"}</strong>
                  </div>
                  <div>
                    <span>端口</span>
                    <strong>{webBridgeStatus?.port ?? "-"}</strong>
                  </div>
                  <div>
                    <span>版本</span>
                    <strong>{webBridgeStatus?.version ?? "-"}</strong>
                  </div>
                </div>
                <div className="statusActions">
                  <button type="button" onClick={refreshWebBridgeStatus}>
                    刷新状态
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveView("home");
                      setInput("检查 Kimi WebBridge 状态，并准备用真实浏览器处理网页任务。");
                    }}
                  >
                    交给 Agent
                  </button>
                </div>
                {!webBridgeStatus?.extension_connected && (
                  <p className="emptyText">
                    daemon 已安装后，还需要启用 Kimi WebBridge 浏览器扩展才能控制真实浏览器。
                  </p>
                )}
              </section>
            )}

            {activeView === "home" && hasConversation && (
              <div className="messageStack" ref={messageStackRef}>
                {messages.map((message) => {
                  if (message.role === "tool") {
                    return (
                      <article className="taskStepCard" key={message.id}>
                        <div className="stepDot done">
                          <Check size={14} />
                        </div>
                        <div className="stepBody">
                          <div className="stepHeader">
                            <strong>{getToolSummary(message)}</strong>
                            <span>{message.toolName || "tool"}</span>
                          </div>
                          <details>
                            <summary>查看工具结果</summary>
                            <pre className="toolContent">{message.content}</pre>
                          </details>
                        </div>
                      </article>
                    );
                  }

                  const msg = message as Message;
                  const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;

                  return (
                    <article className={`message ${msg.role}`} key={msg.id}>
                      <div className="avatar">
                        {msg.role === "user" ? <UserRound size={18} /> : <Bot size={18} />}
                      </div>
                      <div className="bubble">
                        {msg.status === "thinking" && <div className="inlineStatus">working</div>}
                        {msg.status === "error" && <div className="inlineStatus errorText">error</div>}
                        {hasToolCalls && (
                          <div className="toolCalls taskStepList">
                            {msg.tool_calls!.map((tc) => (
                              <div className="toolCallItem taskStepInline" key={tc.id}>
                                <span className="stepDot pending">
                                  <Wrench size={13} />
                                </span>
                                <span>{getToolCallSummary(tc)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {msg.content && (
                          <div className="richText">
                            {msg.role === "assistant" ? renderRichText(msg.content) : <p>{msg.content}</p>}
                          </div>
                        )}
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="messageAttachments">
                            {msg.attachments.map((attachment) => (
                              <a
                                className="messageAttachment"
                                href={attachment.url}
                                target="_blank"
                                rel="noreferrer"
                                key={attachment.id}
                              >
                                {attachment.kind === "image" ? <ImageIcon size={15} /> : <FileText size={15} />}
                                <span>{attachment.originalName}</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {activeView === "home" && artifacts.length > 0 && (
              <section className="artifactShelf" aria-label="任务产物">
                {artifacts.map((artifact) => (
                  <a
                    className="artifactCard"
                    href={artifact.href}
                    target={artifact.href === "#" ? undefined : "_blank"}
                    rel="noreferrer"
                    key={artifact.id}
                    onClick={(event) => {
                      if (artifact.href === "#") event.preventDefault();
                    }}
                  >
                    <span className="artifactIcon">
                      {artifact.kind === "image" ? <ImageIcon size={17} /> : <FileText size={17} />}
                    </span>
                    <span>
                      <strong>{artifact.title}</strong>
                      <small>{artifact.description}</small>
                    </span>
                    {artifact.href !== "#" ? <Download size={15} /> : <Clipboard size={15} />}
                  </a>
                ))}
              </section>
            )}

            {activeView === "home" && !hasConversation && !isBooting && (
              <div className="skillCards">
                {skills.map((skill) => {
                  const Icon = skillIcons[skill.id];
                  return (
                    <button
                      className="skillCard"
                      type="button"
                      key={skill.id}
                      onClick={() => connectSkill(skill.id, skill.title)}
                    >
                      <span className={`skillIcon ${skill.accent}`}>
                        <Icon size={22} />
                      </span>
                      <strong>{skill.title}</strong>
                      <small>
                        {skill.connected ? "已连接，可以用于当前任务" : skill.description}
                      </small>
                    </button>
                  );
                })}
              </div>
            )}

            {activeView === "home" && showProjectLoader && (
              <form className="projectLoader" onSubmit={loadLocalProject}>
                <div className="projectLoaderHeader">
                  <span className="projectLoaderIcon">
                    <Folder size={18} />
                  </span>
                  <div>
                    <strong>进入本地项目工作</strong>
                    <small>Agent 的读取、搜索、修改、运行命令和测试都会默认在这个目录中执行。</small>
                  </div>
                </div>
                <div className="projectPathRow">
                  <input
                    value={projectPath}
                    onChange={(event) => setProjectPath(event.target.value)}
                    placeholder="/Users/you/Projects/example"
                  />
                  <button type="submit">加载项目</button>
                </div>
                {activeWorkspaceName && (
                  <div className="projectPreview">
                    <div className="projectPreviewTitle">
                      <span>当前项目</span>
                      <strong>{activeWorkspaceName}</strong>
                    </div>
                    {visibleProjectTree.length > 0 && (
                      <div className="treeList">
                        {visibleProjectTree.map((node) => (
                          <div className="treeRow" key={node.path}>
                            {node.type === "dir" ? <Folder size={14} /> : <FileText size={14} />}
                            <span>{node.path}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </form>
            )}

            <form className="taskComposer" onSubmit={sendMessage}>
              {pendingAttachments.length > 0 && (
                <div className="attachmentTray">
                  {pendingAttachments.map((attachment) => (
                    <div className="attachmentChip" key={attachment.id}>
                      <span className="attachmentThumb">
                        {attachment.kind === "image" ? (
                          <img src={attachment.url} alt={attachment.originalName} />
                        ) : (
                          <FileText size={16} />
                        )}
                      </span>
                      <span>
                        <strong>{attachment.originalName}</strong>
                        <small>{formatFileSize(attachment.size)}</small>
                      </span>
                      <button
                        type="button"
                        title="移除附件"
                        onClick={() => removePendingAttachment(attachment.id)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                onPaste={handlePaste}
                placeholder='输入 "/" 快速使用技能'
                rows={3}
              />
              <input
                ref={fileInputRef}
                className="hiddenFileInput"
                type="file"
                multiple
                accept="image/*,.txt,.md,.csv,.json,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.sql,.yaml,.yml,.toml,.log,.pdf,.doc,.docx,.xls,.xlsx"
                onChange={(event) => {
                  if (event.target.files) void uploadFiles(event.target.files);
                }}
              />
              <div className="composerBar">
                <div className="leftControls">
                  <div className="addMenuWrap">
                    <button
                      className={`roundButton ${showAddMenu ? "active" : ""}`}
                      type="button"
                      title="添加"
                      onClick={() => setShowAddMenu((value) => !value)}
                    >
                      <Plus size={22} />
                    </button>
                    {showAddMenu && (
                      <div className="addMenu">
                        <button
                          type="button"
                          onClick={() => {
                            setShowAddMenu(false);
                            fileInputRef.current?.click();
                          }}
                        >
                          <Paperclip size={16} />
                          上传文件或图片
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAddMenu(false);
                            setActiveView("home");
                            setShowProjectLoader(true);
                          }}
                        >
                          <Folder size={16} />
                          选择本地项目
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAddMenu(false);
                            setInput((current) => current || "请读取并整理这个网页：");
                          }}
                        >
                          <Globe2 size={16} />
                          添加网页链接
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAddMenu(false);
                            void navigator.clipboard?.readText().then((text) => {
                              if (text) setInput((current) => (current ? `${current}\n${text}` : text));
                            });
                          }}
                        >
                          <Clipboard size={16} />
                          粘贴剪贴板文本
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    className="permissionButton"
                    type="button"
                    onClick={() =>
                      setPermission((value) => (value === "全部允许" ? "确认后执行" : "全部允许"))
                    }
                  >
                    <ShieldCheck size={17} />
                    {permission}
                    <ChevronDown size={16} />
                  </button>
                </div>
                <div className="rightControls">
                  <button className="textButton" type="button">
                    {settings.model || "选择模型"}
                    <ChevronDown size={16} />
                  </button>
                  <button
                    className={`agentToggle ${mode === "agent" ? "active" : ""}`}
                    type="button"
                    onClick={() => setMode("agent")}
                  >
                    Agent
                  </button>
                  <button
                    className={`agentToggle ${mode === "team" ? "active" : ""}`}
                    type="button"
                    onClick={() => setMode("team")}
                  >
                    Agent 集群
                  </button>
                  <button className="micButton" type="button" title="语音输入">
                    <Mic size={18} />
                  </button>
                  <button className="submitButton" type="submit" disabled={isWorking || !input.trim()}>
                    {isWorking ? <CircleDot size={20} /> : <ArrowUp size={22} />}
                  </button>
                </div>
              </div>
              <div className="contextBar">
                <button
                  className={showProjectLoader ? "active" : ""}
                  type="button"
                  onClick={() => {
                    setActiveView("home");
                    setShowProjectLoader((value) => !value);
                  }}
                >
                  <Folder size={18} />
                  {activeWorkspaceName ? activeWorkspaceName : "进入项目工作"}
                  <ChevronDown size={16} />
                </button>
                <button type="button" onClick={() => fileInputRef.current?.click()}>
                  <Paperclip size={17} />
                  添加资料
                </button>
                <button type="button" onClick={createAutomation}>
                  <Workflow size={17} />
                  创建自动化
                </button>
              </div>
            </form>
          </section>
        </div>

        <footer className="stageFooter">
          <span>
            <Check size={15} />
            OpenAI-compatible API
          </span>
          {skills.some((skill) => skill.id === "webbridge" && skill.installed !== false) && (
            <span>
              <Globe2 size={15} />
              Kimi WebBridge
            </span>
          )}
          <span>
            <Sparkles size={15} />
            通用办公 Agent
          </span>
          <span>
            <Send size={15} />
            自由接入能力
          </span>
        </footer>
      </section>
    </main>
  );
}

function titleFromPrompt(prompt: string) {
  return prompt.length > 22 ? `${prompt.slice(0, 22)}...` : prompt;
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function renderRichText(content: string) {
  const blocks = content
    .replace(/```[\w-]*\n?/g, "\n")
    .replace(/```/g, "\n")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "\n")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, index) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const firstLine = lines[0] || "";
    const heading = firstLine.match(/^#{1,6}\s+(.+)$/);
    if (heading) return <h3 key={index}>{renderInlineText(heading[1])}</h3>;

    if (lines.every((line) => /^[-*]\s+/.test(line))) {
      return (
        <ul key={index}>
          {lines.map((line, itemIndex) => (
            <li key={itemIndex}>{renderInlineText(line.replace(/^[-*]\s+/, ""))}</li>
          ))}
        </ul>
      );
    }

    if (lines.every((line) => /^\d+\.\s+/.test(line))) {
      return (
        <ol key={index}>
          {lines.map((line, itemIndex) => (
            <li key={itemIndex}>{renderInlineText(line.replace(/^\d+\.\s+/, ""))}</li>
          ))}
        </ol>
      );
    }

    if (lines.length > 1 && lines.every((line) => line.startsWith("|") && line.endsWith("|"))) {
      return (
        <div className="softTable" key={index}>
          {lines.map((line, rowIndex) => (
            <div className="softTableRow" key={rowIndex}>
              {line
                .slice(1, -1)
                .split("|")
                .map((cell) => cell.trim())
                .filter(Boolean)
                .map((cell, cellIndex) => (
                  <span key={cellIndex}>{renderInlineText(cell)}</span>
                ))}
            </div>
          ))}
        </div>
      );
    }

    return <p key={index}>{renderInlineText(lines.join("\n"))}</p>;
  });
}

function renderInlineText(value: string) {
  const cleaned = value.replace(/^>\s?/, "").replace(/`([^`]+)`/g, "$1");
  const parts = cleaned.split(/(\*\*[^*]+\*\*|__[^_]+__)/g).filter(Boolean);
  return parts.map((part, index) => {
    const strong = part.match(/^(?:\*\*|__)(.+)(?:\*\*|__)$/);
    return strong ? <strong key={index}>{strong[1]}</strong> : <span key={index}>{part.replace(/\*([^*\n]+)\*/g, "$1")}</span>;
  });
}

function getToolCallSummary(toolCall: ToolCall) {
  const name = toolCall.function.name;
  if (name === "search_web") return "正在搜索网页";
  if (name === "fetch_url") return "正在读取网页内容";
  if (name === "webbridge_command") return "正在操作真实浏览器";
  if (name === "read_file" || name === "read_attachment") return "正在读取文件";
  if (name === "write_file" || name === "replace_in_file") return "正在修改文件";
  if (name === "transform_image") return "正在生成修改后的图片";
  if (name === "run_tests") return "正在运行验证命令";
  return `正在调用 ${name}`;
}

function getToolSummary(message: ToolMessage) {
  if (message.toolName === "search_web") return "网页搜索完成";
  if (message.toolName === "fetch_url") return "网页读取完成";
  if (message.toolName === "webbridge_command") return "浏览器操作完成";
  if (message.toolName === "transform_image") return "图片处理完成";
  if (message.toolName === "write_file" || message.toolName === "replace_in_file") return "文件修改完成";
  if (message.toolName === "run_tests") return message.content.startsWith("Command failed") ? "验证未通过" : "验证完成";
  return "工具执行完成";
}

function extractArtifacts(messages: StoredMessage[]): Artifact[] {
  const artifacts = new Map<string, Artifact>();
  for (const message of messages) {
    if (message.role !== "tool") {
      message.attachments?.forEach((attachment) => {
        artifacts.set(attachment.id, {
          id: attachment.id,
          title: attachment.originalName,
          description: attachment.kind === "image" ? "图片附件" : "文件附件",
          href: attachment.url,
          kind: attachment.kind === "image" ? "image" : "file"
        });
      });
      continue;
    }

    const urlMatch = message.content.match(/URL:\s*(\/api\/attachments\/[^\s]+)/);
    if (urlMatch) {
      artifacts.set(`${message.id}-image`, {
        id: `${message.id}-image`,
        title: "处理后的图片",
        description: message.toolName || "图片产物",
        href: urlMatch[1],
        kind: "image"
      });
    }

    const fileMatch = message.content.match(/(?:File written|Updated):\s*([^\n(]+)/);
    if (fileMatch) {
      artifacts.set(`${message.id}-file`, {
        id: `${message.id}-file`,
        title: fileMatch[1].trim(),
        description: "项目文件产物",
        href: "#",
        kind: "file"
      });
    }
  }
  return [...artifacts.values()].slice(-6);
}

function removeMessage(messages: StoredMessage[], id: string) {
  return messages.filter((message) => message.id !== id);
}

function upsertStreamMessage(messages: StoredMessage[], nextMessage: StoredMessage) {
  const index = messages.findIndex((message) => message.id === nextMessage.id);
  if (index < 0) return [...messages, nextMessage];
  return messages.map((message, currentIndex) => (currentIndex === index ? nextMessage : message));
}

function flattenProjectTree(nodes: ProjectTreeNode[], prefix = ""): ProjectTreeNode[] {
  return nodes.flatMap((node) => {
    const visibleNode = {
      ...node,
      path: prefix ? `${prefix}/${node.name}` : node.path
    };
    return [visibleNode, ...flattenProjectTree(node.children || [], visibleNode.path)];
  });
}

export default App;
