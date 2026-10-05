import { computeNextRunAt } from "./schedule.js";
import { sanitizeFileName } from "../core/paths.js";
import type { AgentResult, Attachment, Automation, AutomationRun, Conversation, Message, PublicAttachment } from "../domain/types.js";

type CreateAutomationRunnerDependencies = {
  automations: Map<string, Automation>;
  runningAutomations: Set<string>;
  persistStore: () => Promise<void>;
  getAutomationConversation: (automation: Automation) => Conversation;
  runAgentLoop: (conversation: Conversation, automation: Automation) => Promise<AgentResult>;
  saveGeneratedTextAttachment: (conversationId: string, originalName: string, content: string) => Promise<Attachment>;
  publicAttachment: (attachment: Attachment) => PublicAttachment;
  id: (prefix: string) => string;
  now: () => string;
};

export function createAutomationRunner(deps: CreateAutomationRunnerDependencies) {
  const {
    automations,
    runningAutomations,
    persistStore,
    getAutomationConversation,
    runAgentLoop,
    saveGeneratedTextAttachment,
    publicAttachment,
    id,
    now
  } = deps;

  function startAutomationScheduler() {
    void runDueAutomations().catch((error) => console.error("Automation scheduler failed", error));
    setInterval(() => {
      void runDueAutomations().catch((error) => console.error("Automation scheduler failed", error));
    }, 30_000);
  }

  async function recover() {
    let changed = false;
    for (const automation of automations.values()) {
      const interrupted = (automation.runs || []).filter((run) => run.status === "running");
      if (!interrupted.length && automation.lastStatus !== "running") continue;
      for (const run of interrupted) {
        run.status = "error";
        run.finishedAt = now();
        run.error = "服务重启中断了任务。请检查已产生的操作后手动重试。";
        run.unread = true;
      }
      automation.lastStatus = "error";
      automation.lastError = "服务重启中断了任务。请检查已产生的操作后手动重试。";
      automation.unreadCount = (automation.unreadCount || 0) + interrupted.length;
      automation.nextRunAt = automation.enabled ? computeNextRunAt(automation.schedule, new Date(Date.now() + 1000)) : undefined;
      automation.updatedAt = now();
      changed = true;
    }
    if (changed) await persistStore();
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
    try {
      await persistStore();
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
  
      const result = await runAgentLoop(conversation, automation);
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
    recover,
    startAutomationScheduler,
    runAutomation
  };
}
