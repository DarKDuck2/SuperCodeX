import {
  AlarmClock,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Clipboard,
  ExternalLink,
  FileCode,
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
  Presentation,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Slack,
  Sparkles,
  Table2,
  Trash2,
  X,
  Wrench,
  Workflow
} from "lucide-react";
import { ClipboardEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { SettingsDock } from "./components/SettingsDock";
import { Sidebar } from "./components/Sidebar";
import {
  buildMessageDisplayItems,
  cleanAssistantContent,
  extractArtifacts,
  flattenProjectTree,
  formatAutomationStatus,
  formatDateTime,
  formatFileSize,
  formatToolRequest,
  formatToolResponse,
  getToolRoundNarrative,
  getToolSequenceSummary,
  removeMessage,
  renderArtifactIcon,
  renderRichText,
  titleFromPrompt,
  upsertStreamMessage
} from "./lib/display";
import { readSseStream } from "./lib/stream";
import type {
  ActiveView,
  AgentStreamEvent,
  ApiSettings,
  AppState,
  Artifact,
  Attachment,
  Automation,
  AutomationPreview,
  ConversationSummary,
  Message,
  Project,
  ProjectTreeNode,
  SearchResult,
  Skill,
  StoredMessage,
  ToolMessage,
  WebBridgeStatus
} from "./types";

const defaultSettings: ApiSettings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1"
};

const skillIcons: Record<string, typeof Slack> = {
  messages: Slack,
  email: Mail,
  files: FileText,
  academic: Sparkles,
  slides: Presentation,
  pdf: FileText,
  search: Search,
  html: FileCode,
  excel: Table2,
  documents: PenLine,
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
  const [settingsStatus, setSettingsStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [mode, setMode] = useState<"agent" | "team">("agent");
  const [activeView, setActiveView] = useState<ActiveView>("home");
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
  const [selectedAutomationId, setSelectedAutomationId] = useState("");
  const [showAutomationDialog, setShowAutomationDialog] = useState(false);
  const [automationInstruction, setAutomationInstruction] = useState("");
  const [customSkillPath, setCustomSkillPath] = useState("");
  const [automationPreview, setAutomationPreview] = useState<AutomationPreview | null>(null);
  const [isEditingAutomation, setIsEditingAutomation] = useState(false);
  const [automationDraft, setAutomationDraft] = useState({ title: "", schedule: "", prompt: "" });
  const activeRequestRef = useRef<AbortController | null>(null);
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
  const artifacts = useMemo(() => extractArtifacts(messages, activeProject?.id), [activeProject?.id, messages]);
  const selectedAutomation = useMemo(
    () =>
      automations.find((automation) => automation.id === selectedAutomationId) ??
      automations[0] ??
      null,
    [automations, selectedAutomationId]
  );
  const unreadAutomationCount = useMemo(
    () => automations.reduce((total, automation) => total + (automation.unreadCount || 0), 0),
    [automations]
  );

  useEffect(() => {
    loadAppState();
  }, []);

  useEffect(() => {
    if (activeView !== "automations") return;
    const timer = window.setInterval(() => {
      void syncAppState();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [activeView]);

  useEffect(() => {
    if (!showAutomationDialog || !automationInstruction.trim()) {
      setAutomationPreview(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void previewAutomation(automationInstruction, controller.signal);
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [automationInstruction, showAutomationDialog]);

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

  async function saveSettings(event?: FormEvent, nextSettings = settings) {
    event?.preventDefault();
    setSettingsStatus("saving");
    const body: ApiSettings | Omit<ApiSettings, "apiKey"> = nextSettings.apiKey
      ? nextSettings
      : {
          baseUrl: nextSettings.baseUrl,
          model: nextSettings.model
        };
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error("API 设置保存失败");
      const payload = (await response.json()) as ApiSettings;
      setSettings({
        baseUrl: payload.baseUrl || nextSettings.baseUrl,
        apiKey: nextSettings.apiKey,
        model: payload.model || nextSettings.model
      });
      setAppError("");
      setSettingsStatus("saved");
    } catch (error) {
      setSettingsStatus("error");
      setAppError(error instanceof Error ? error.message : "API 设置保存失败");
    }
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
        content: "正在理解你的请求，整理下一步。"
      }
    ]);
    setIsWorking(true);
    const controller = new AbortController();
    activeRequestRef.current = controller;

    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: settings.apiKey ? settings : undefined,
          content: prompt || "请处理这些附件。",
          attachmentIds: pendingAttachments.map((attachment) => attachment.id),
          stream: true
        }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({ error: "请求失败" }));
        throw new Error(payload.error ?? "请求失败");
      }
      await readSseStream<AgentStreamEvent>(response, (event) => handleAgentEvent(event, pendingId));
      await syncAppState();
      setActiveConversationId(conversationId);
    } catch (error) {
      const stopped = error instanceof DOMException && error.name === "AbortError";
      setMessages((current) =>
        current.map((message) =>
          message.id === pendingId
            ? {
                ...message,
                status: stopped ? "done" : "error",
                content: stopped
                  ? "已停止本次回答。"
                  : error instanceof Error
                    ? `调用失败：${error.message}`
                    : "调用失败：未知错误"
              }
            : message
        )
      );
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
      setIsWorking(false);
    }
  }

  function stopAgentRun() {
    activeRequestRef.current?.abort();
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

  async function loadCustomSkill(event: FormEvent) {
    event.preventDefault();
    const path = customSkillPath.trim();
    if (!path) return;
    const response = await fetch("/api/skills/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, connect: true })
    });
    const payload = await response.json();
    if (!response.ok) {
      setAppError(payload.error || "加载 skill 失败");
      return;
    }
    setSkills((current) => {
      const next = current.filter((skill) => skill.id !== payload.skill.id);
      return [...next, payload.skill];
    });
    setCustomSkillPath("");
    useSkillPrompt(payload.skill.title);
  }

  function createAutomation() {
    setAutomationInstruction(input.trim());
    setShowAutomationDialog(true);
  }

  async function previewAutomation(instruction: string, signal?: AbortSignal) {
    const response = await fetch("/api/automations/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction }),
      signal
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { preview: AutomationPreview };
    setAutomationPreview(payload.preview);
  }

  async function submitAutomation(event: FormEvent) {
    event.preventDefault();
    const instruction = automationInstruction.trim();
    if (!instruction) return;
    const response = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction })
    });
    const payload = (await response.json()) as { automation?: Automation; error?: string };
    if (!response.ok || !payload.automation) throw new Error(payload.error || "创建自动化失败");
    setInput("");
    setAutomationInstruction("");
    setShowAutomationDialog(false);
    setSelectedAutomationId(payload.automation.id);
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

  function startEditAutomation(automation: Automation) {
    setAutomationDraft({
      title: automation.title,
      schedule: automation.schedule,
      prompt: automation.prompt
    });
    setIsEditingAutomation(true);
  }

  async function saveAutomationEdit() {
    if (!selectedAutomation) return;
    const response = await fetch(`/api/automations/${selectedAutomation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(automationDraft)
    });
    if (!response.ok) throw new Error("更新自动化失败");
    setIsEditingAutomation(false);
    await syncAppState();
  }

  async function runAutomationNow(automation: Automation) {
    const response = await fetch(`/api/automations/${automation.id}/run`, { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "立即运行失败" }));
      throw new Error(payload.error || "立即运行失败");
    }
    await syncAppState();
  }

  async function markAutomationRead(automation: Automation) {
    if (!automation.unreadCount) return;
    await fetch(`/api/automations/${automation.id}/read`, { method: "POST" });
    await syncAppState();
  }

  async function deleteAutomation(id: string) {
    const response = await fetch(`/api/automations/${id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 204) throw new Error("删除自动化失败");
    setSelectedAutomationId((current) => (current === id ? "" : current));
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

  async function openArtifact(artifact: Artifact, action: "open" | "reveal" = "open") {
    if (!artifact.filePath || !activeProject?.id) {
      if (artifact.href && artifact.href !== "#") window.open(artifact.href, "_blank", "noreferrer");
      return;
    }

    try {
      setAppError("");
      const response = await fetch(`/api/projects/${activeProject.id}/files/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: artifact.filePath, action })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "打开文件失败");
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "打开文件失败");
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
      <Sidebar
        activeConversationId={activeConversationId}
        activeView={activeView}
        historyItems={historyItems}
        isCollapsed={isSidebarCollapsed}
        unreadAutomationCount={unreadAutomationCount}
        onCreateTask={createTask}
        onLoadMessages={loadMessages}
        onSelectView={(view) => {
          setActiveView(view);
          if (view === "webbridge") refreshWebBridgeStatus();
        }}
        onToggleCollapsed={() => setIsSidebarCollapsed((value) => !value)}
      />

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
          <SettingsDock
            settings={settings}
            status={settingsStatus}
            onChange={setSettings}
            onStatusReset={() => setSettingsStatus("idle")}
            onSubmit={(event) => saveSettings(event)}
          />
        )}

        <div
          className={`heroWork ${hasConversation || activeView !== "home" ? "withMessages" : "emptyHome"}`}
        >
          <section className="conversationPane">
            {(activeView !== "home" || !hasConversation) && (
              <div className="titleBlock">
                {activeView === "home" && hasConversation && (
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
              <>
                <form className="skillLoader" onSubmit={loadCustomSkill}>
                  <Plus size={17} />
                  <input
                    value={customSkillPath}
                    onChange={(event) => setCustomSkillPath(event.target.value)}
                    placeholder="加载本地 skill 目录、SKILL.md 或 manifest 路径"
                  />
                  <button type="submit">加载</button>
                </form>
                <div className="skillCards alwaysVisible">
                  {skills.map((skill) => {
                    const Icon = skillIcons[skill.id] || Workflow;
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
                        <span className="skillMeta">
                          {(skill.categories || []).slice(0, 3).join(" / ") || skill.source || "skill"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {activeView === "automations" && (
              <section className="automationWorkspace">
                <div className="automationToolbar">
                  <button className="primaryAction" type="button" onClick={createAutomation}>
                    <Plus size={17} />
                    创建自动化
                  </button>
                </div>
                {automations.length === 0 ? (
                  <section className="utilityPanel">
                    <p className="emptyText">
                      还没有定时任务。点击“创建自动化”，输入“每天早上9点返回新闻”“11:30返回早盘情况”“每2h提醒喝水和休息”即可创建。
                    </p>
                  </section>
                ) : (
                  <div className="automationLayout">
                    <section className="utilityPanel automationListPanel">
                      <div className="utilityList">
                        {automations.map((automation) => (
                          <button
                            className={`utilityRow automationRow ${
                              selectedAutomation?.id === automation.id ? "active" : ""
                            }`}
                            type="button"
                            key={automation.id}
                            onClick={() => {
                              setSelectedAutomationId(automation.id);
                              setIsEditingAutomation(false);
                              void markAutomationRead(automation);
                            }}
                          >
                            <Workflow size={17} />
                            <span>
                              <strong>
                                {automation.title}
                                {(automation.unreadCount || 0) > 0 && (
                                  <em className="inlineBadge">{automation.unreadCount}</em>
                                )}
                              </strong>
                              <small>
                                {automation.schedule}
                                {automation.nextRunAt ? ` · 下次 ${formatDateTime(automation.nextRunAt)}` : ""}
                              </small>
                              <small className={`automationStatus ${automation.lastStatus || "never"}`}>
                                {formatAutomationStatus(automation)}
                              </small>
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>

                    {selectedAutomation && (
                      <section className="automationDetail">
                        <div className="detailHeader">
                          <span className="detailIcon">
                            <Workflow size={18} />
                          </span>
                          <div>
                            <strong>{selectedAutomation.title}</strong>
                            <small>{selectedAutomation.enabled ? "运行中" : "已停用"}</small>
                          </div>
                        </div>
                        {isEditingAutomation ? (
                          <div className="detailEditor">
                            <label>
                              <span>标题</span>
                              <input
                                value={automationDraft.title}
                                onChange={(event) =>
                                  setAutomationDraft((draft) => ({ ...draft, title: event.target.value }))
                                }
                              />
                            </label>
                            <label>
                              <span>时间规则</span>
                              <input
                                value={automationDraft.schedule}
                                onChange={(event) =>
                                  setAutomationDraft((draft) => ({ ...draft, schedule: event.target.value }))
                                }
                              />
                            </label>
                            <label>
                              <span>任务内容</span>
                              <textarea
                                value={automationDraft.prompt}
                                onChange={(event) =>
                                  setAutomationDraft((draft) => ({ ...draft, prompt: event.target.value }))
                                }
                                rows={4}
                              />
                            </label>
                            <div className="detailActions">
                              <button className="primaryAction" type="button" onClick={saveAutomationEdit}>
                                保存修改
                              </button>
                              <button type="button" onClick={() => setIsEditingAutomation(false)}>
                                取消
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <dl className="detailGrid">
                              <div>
                                <dt>时间规则</dt>
                                <dd>{selectedAutomation.schedule}</dd>
                              </div>
                              <div>
                                <dt>下次运行</dt>
                                <dd>{selectedAutomation.nextRunAt ? formatDateTime(selectedAutomation.nextRunAt) : "-"}</dd>
                              </div>
                              <div>
                                <dt>已执行</dt>
                                <dd>{selectedAutomation.runCount ?? 0} 次</dd>
                              </div>
                              <div>
                                <dt>最近状态</dt>
                                <dd className={`automationStatus ${selectedAutomation.lastStatus || "never"}`}>
                                  {formatAutomationStatus(selectedAutomation)}
                                </dd>
                              </div>
                            </dl>
                            <div className="detailBlock">
                              <span>任务内容</span>
                              <p>{selectedAutomation.prompt}</p>
                            </div>
                          </>
                        )}
                        {selectedAutomation.lastResult && (
                          <div className="detailBlock">
                            <span>最近结果</span>
                            <p>{selectedAutomation.lastResult}</p>
                          </div>
                        )}
                        {selectedAutomation.runs && selectedAutomation.runs.length > 0 && (
                          <div className="runHistory">
                            <span>执行历史</span>
                            {selectedAutomation.runs.slice(0, 8).map((run) => (
                              <div className={`runItem ${run.status}`} key={run.id}>
                                <div>
                                  <strong>
                                    {run.trigger === "manual" ? "立即运行" : "定时运行"}
                                    {run.unread && <em className="inlineBadge">新</em>}
                                  </strong>
                                  <small>
                                    {formatDateTime(run.startedAt)}
                                    {run.status === "running" ? " · 执行中" : ""}
                                  </small>
                                  {run.error && <small className="automationStatus error">{run.error}</small>}
                                </div>
                                {run.documentAttachmentId && (
                                  <a
                                    href={`/api/attachments/${run.documentAttachmentId}/content`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    打开
                                  </a>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="detailActions">
                          {selectedAutomation.lastDocumentAttachmentId && (
                            <a
                              className="detailButton"
                              href={`/api/attachments/${selectedAutomation.lastDocumentAttachmentId}/content`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <FileText size={16} />
                              打开结果文档
                            </a>
                          )}
                          {selectedAutomation.conversationId && (
                            <button type="button" onClick={() => loadMessages(selectedAutomation.conversationId!)}>
                              <MessageCircle size={16} />
                              查看执行会话
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={selectedAutomation.lastStatus === "running"}
                            onClick={() => runAutomationNow(selectedAutomation)}
                          >
                            <CircleDot size={16} />
                            立即运行
                          </button>
                          <button type="button" onClick={() => startEditAutomation(selectedAutomation)}>
                            <PenLine size={16} />
                            编辑任务
                          </button>
                          <button type="button" onClick={() => toggleAutomation(selectedAutomation)}>
                            {selectedAutomation.enabled ? "停用任务" : "启用任务"}
                          </button>
                          <button
                            className="dangerAction"
                            type="button"
                            onClick={() => deleteAutomation(selectedAutomation.id)}
                          >
                            <Trash2 size={16} />
                            删除任务
                          </button>
                        </div>
                      </section>
                    )}
                  </div>
                )}
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
                {buildMessageDisplayItems(messages).map((item) => {
                  if (item.type === "toolRound") {
                    const toolCalls = item.rounds.flatMap((round) => round.assistant?.tool_calls || []);
                    const toolResults = item.rounds.flatMap((round) => round.toolResults);
                    const isPending = toolCalls.length > toolResults.length || toolResults.length === 0;
                    return (
                      <article className="toolTimelineItem" key={item.id}>
                        <div className="toolTimelineRail">
                          <span className={`toolTimelineIcon ${isPending ? "pending" : "done"}`}>
                            {isPending ? <Wrench size={15} /> : <Check size={15} />}
                          </span>
                        </div>
                        <div className="toolTimelineBody">
                          <div className="agentProcess">
                            {item.rounds.map((round, roundIndex) => {
                              const visibleContent = cleanAssistantContent(round.assistant?.content || "");
                              return (
                                <div className="agentProcessStep" key={`${item.id}-step-${roundIndex}`}>
                                  <span className="agentProcessDot" />
                                  <div>
                                    {visibleContent ? renderRichText(visibleContent) : <p>{getToolRoundNarrative(round, roundIndex)}</p>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <details className="toolRoundDetails">
                            <summary className="toolTimelineSummary">
                              <span>{getToolSequenceSummary(toolCalls, toolResults)}</span>
                              <ChevronDown size={16} />
                            </summary>
                            <div className="toolRoundPayloads">
                              {item.rounds.map((round, roundIndex) => (
                                <div className="toolPayloadGroup" key={`${item.id}-payload-${roundIndex}`}>
                                  {item.rounds.length > 1 && <span className="toolPayloadGroupTitle">步骤 {roundIndex + 1}</span>}
                                  {(round.assistant?.tool_calls || []).map((tc) => (
                                    <div className="toolPayloadCard" key={tc.id}>
                                      <strong>Request · {tc.function.name}</strong>
                                      <pre className="toolContent">{formatToolRequest(tc)}</pre>
                                    </div>
                                  ))}
                                  {round.toolResults.map((result) => (
                                    <div className="toolPayloadCard" key={result.id}>
                                      <strong>Response · {result.toolName || "tool"}</strong>
                                      <pre className="toolContent">{formatToolResponse(result.content)}</pre>
                                    </div>
                                  ))}
                                </div>
                              ))}
                            </div>
                          </details>
                        </div>
                      </article>
                    );
                  }

                  const msg = item.message;
                  const visibleContent = cleanAssistantContent(msg.content);

                  if (msg.role === "user") {
                    return (
                      <article className="message userMessage" key={msg.id}>
                        <div className="userBubble">
                          <p>{msg.content}</p>
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
                  }

                  if (!visibleContent && !msg.attachments?.length && !msg.status) {
                    return null;
                  }

                  return (
                    <article className="message assistantMessage" key={msg.id}>
                      <div className="assistantText">
                        {msg.status === "thinking" && <div className="inlineStatus">working</div>}
                        {msg.status === "error" && <div className="inlineStatus errorText">error</div>}
                        {visibleContent && <div className="richText">{renderRichText(visibleContent)}</div>}
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
                  <div
                    className="artifactCard"
                    key={artifact.id}
                  >
                    <button className="artifactMain" type="button" onClick={() => openArtifact(artifact)}>
                      <span className="artifactIcon">
                        {renderArtifactIcon(artifact)}
                      </span>
                      <span>
                        <strong>{artifact.title}</strong>
                        <small>{artifact.description}</small>
                      </span>
                    </button>
                    <button
                      className="artifactAction"
                      type="button"
                      title="在文件夹中显示"
                      aria-label={`在文件夹中显示 ${artifact.title}`}
                      onClick={() => openArtifact(artifact, "reveal")}
                    >
                      {artifact.filePath ? <Folder size={15} /> : <ExternalLink size={15} />}
                    </button>
                  </div>
                ))}
              </section>
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
                    title="自动执行常规操作，危险删除和重置类命令会被系统拦截"
                  >
                    <ShieldCheck size={17} />
                    自动安全
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
                  <button
                    className={`submitButton ${isWorking ? "stop" : ""}`}
                    type={isWorking ? "button" : "submit"}
                    title={isWorking ? "停止回答" : "发送"}
                    disabled={!isWorking && !input.trim()}
                    onClick={isWorking ? stopAgentRun : undefined}
                  >
                    {isWorking ? <X size={20} /> : <ArrowUp size={22} />}
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

        {showAutomationDialog && (
          <div className="modalOverlay" role="presentation">
            <form className="automationDialog" onSubmit={submitAutomation}>
              <div className="dialogHeader">
                <div>
                  <strong>创建自动化</strong>
                  <span>写一句自然语言任务，SuperCodex 会解析时间并自动执行。</span>
                </div>
                <button
                  type="button"
                  title="关闭"
                  onClick={() => {
                    setShowAutomationDialog(false);
                    setAutomationInstruction("");
                  }}
                >
                  <X size={17} />
                </button>
              </div>
              <textarea
                value={automationInstruction}
                onChange={(event) => setAutomationInstruction(event.target.value)}
                placeholder="例如：每天早上9点返回新闻"
                rows={5}
                autoFocus
              />
              {automationPreview && (
                <div className="automationPreview">
                  <div>
                    <span>任务</span>
                    <strong>{automationPreview.prompt}</strong>
                  </div>
                  <div>
                    <span>时间</span>
                    <strong>{automationPreview.schedule}</strong>
                  </div>
                  <div>
                    <span>下次运行</span>
                    <strong>{automationPreview.nextRunAt ? formatDateTime(automationPreview.nextRunAt) : "-"}</strong>
                  </div>
                </div>
              )}
              <div className="dialogExamples">
                <button type="button" onClick={() => setAutomationInstruction("每天早上9点返回新闻")}>
                  每天 09:00 新闻
                </button>
                <button type="button" onClick={() => setAutomationInstruction("11:30返回早盘情况")}>
                  11:30 早盘
                </button>
                <button type="button" onClick={() => setAutomationInstruction("每2h提醒喝水和休息")}>
                  每 2h 休息
                </button>
              </div>
              <div className="dialogActions">
                <button
                  type="button"
                  onClick={() => {
                    setShowAutomationDialog(false);
                    setAutomationInstruction("");
                  }}
                >
                  取消
                </button>
                <button className="primaryAction" type="submit" disabled={!automationInstruction.trim()}>
                  创建
                </button>
              </div>
            </form>
          </div>
        )}

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

export default App;
