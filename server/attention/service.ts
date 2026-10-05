import type { Approval, AttentionItem, AttentionState, Automation, Goal } from "../domain/types.js";

export function createAttentionService(deps: {
  state: AttentionState;
  goals: Map<string, Goal>;
  approvals: Map<string, Approval>;
  automations: Map<string, Automation>;
  persistStore: () => Promise<void>;
}) {
  const { state, goals, approvals, automations, persistStore } = deps;

  function list(): AttentionItem[] {
    const items: AttentionItem[] = [];
    const readIds = new Set(state.readIds);
    for (const approval of approvals.values()) {
      if (approval.status !== "pending") continue;
      const id = `approval:${approval.id}`;
      items.push({ id, kind: "approval", priority: "important", title: `工具操作等待审批：${approval.toolName}`, summary: "Agent 正在等待你的决定。", createdAt: approval.createdAt, read: readIds.has(id), approvalId: approval.id, goalId: approval.goalId, automationId: approval.automationId });
    }
    for (const goal of goals.values()) {
      for (const event of goal.activity) {
        if (!["completed", "failed", "interrupted"].includes(event.kind)) continue;
        const id = `goal:${event.id}`;
        items.push({ id, kind: "goal", priority: event.kind === "completed" ? "normal" : "important", title: goal.title, summary: event.text, createdAt: event.createdAt, read: readIds.has(id), goalId: goal.id });
      }
      for (const review of goal.reviews || []) {
        const pending = review.suggestions.filter((item) => item.status === "pending");
        if (!pending.length || goal.status === "completed") continue;
        const id = `review:${review.id}`;
        items.push({ id, kind: "review", priority: "important", title: `${goal.title} 有后续建议`, summary: `${pending.length} 条建议等待你决定。`, createdAt: review.createdAt, read: readIds.has(id), goalId: goal.id });
      }
    }
    for (const automation of automations.values()) {
      for (const run of automation.runs || []) {
        if (run.status === "running") continue;
        const id = `automation:${run.id}`;
        items.push({ id, kind: "automation", priority: run.status === "error" ? "important" : "normal", title: automation.title, summary: run.status === "error" ? `运行失败：${run.error || "未知错误"}` : "定时任务已完成。", createdAt: run.finishedAt || run.startedAt, read: readIds.has(id), automationId: automation.id });
      }
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  }

  function shouldAlert(item: AttentionItem) {
    return !item.read && state.mode !== "off" && (state.mode === "all" || item.priority === "important");
  }

  async function setMode(mode: AttentionState["mode"]) {
    const previous = state.mode;
    state.mode = mode;
    try { await persistStore(); }
    catch (error) { state.mode = previous; throw error; }
    return state.mode;
  }

  async function markRead(itemId: string) {
    if (!list().some((item) => item.id === itemId)) return false;
    if (state.readIds.includes(itemId)) return true;
    const previous = state.readIds;
    state.readIds = [itemId, ...previous].slice(0, 2000);
    try { await persistStore(); }
    catch (error) { state.readIds = previous; throw error; }
    return true;
  }

  async function markAllRead() {
    const previous = state.readIds;
    state.readIds = [...new Set([...list().map((item) => item.id), ...previous])].slice(0, 2000);
    try { await persistStore(); }
    catch (error) { state.readIds = previous; throw error; }
  }

  function snapshot() {
    const items = list();
    return { mode: state.mode, items, unreadAlertCount: items.filter(shouldAlert).length };
  }

  return { list, snapshot, shouldAlert, setMode, markRead, markAllRead };
}
