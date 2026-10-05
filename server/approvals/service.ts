import type { Approval } from "../domain/types.js";
import { createHash } from "node:crypto";

type Input = {
  goalId?: string;
  taskId?: string;
  conversationId?: string;
  automationId?: string;
  toolName: string;
  riskLevel: string;
  args: Record<string, unknown>;
  toolCallId?: string;
  signal?: AbortSignal;
};

export type ApprovalMode = "auto" | "manual";

export function createApprovalService(deps: {
  approvals: Map<string, Approval>;
  persistStore: () => Promise<void>;
  id: (prefix: string) => string;
  now: () => string;
  describeAction?: (input: Input) => Promise<string | undefined>;
  mode?: ApprovalMode;
}) {
  const { approvals, persistStore, id, now, describeAction } = deps;
  const mode = deps.mode || "auto";
  const waiting = new Map<string, (approved: boolean) => void>();
  const deciding = new Set<string>();

  async function request(input: Input): Promise<boolean> {
    if (input.signal?.aborted) return false;
    const detail = await describeAction?.(input);
    if (input.signal?.aborted) return false;
    const summary = [detail, summarizeArgs(input.args)].filter(Boolean).join("\n");
    if (mode === "manual" && summary.length > 32_000) throw new Error("审批内容超过 32000 字符，请拆分工具操作后重试");
    const approval: Approval = {
      id: id("approval"),
      goalId: input.goalId,
      taskId: input.taskId,
      conversationId: input.conversationId,
      automationId: input.automationId,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      riskLevel: input.riskLevel,
      summary: mode === "auto" ? compactSummary(summary) : summary,
      status: mode === "auto" ? "approved" : "pending",
      createdAt: now(),
      decidedAt: mode === "auto" ? now() : undefined,
      decisionSource: mode === "auto" ? "automatic" : undefined
    };
    approvals.set(approval.id, approval);
    if (mode === "auto") {
      try { await persistStore(); }
      catch (error) { approvals.delete(approval.id); throw error; }
      if (input.signal?.aborted) {
        approval.status = "cancelled";
        approval.decidedAt = now();
        await persistStore();
        return false;
      }
      return true;
    }
    return new Promise<boolean>((resolve, reject) => {
      const settle = (approved: boolean) => {
        waiting.delete(approval.id);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(approved);
      };
      const onAbort = () => { void decide(approval.id, false, true).catch(() => settle(false)); };
      waiting.set(approval.id, settle);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      void persistStore().catch((error) => {
        waiting.delete(approval.id);
        input.signal?.removeEventListener("abort", onAbort);
        approvals.delete(approval.id);
        reject(error);
      });
    });
  }

  async function decide(approvalId: string, approved: boolean, cancelled = false) {
    const approval = approvals.get(approvalId);
    if (!approval || approval.status !== "pending" || !waiting.has(approvalId) || deciding.has(approvalId)) return false;
    deciding.add(approvalId);
    approval.status = cancelled ? "cancelled" : approved ? "approved" : "rejected";
    approval.decidedAt = now();
    approval.decisionSource = cancelled ? undefined : "user";
    try {
      await persistStore();
    } catch (error) {
      approval.status = "pending";
      approval.decidedAt = undefined;
      approval.decisionSource = undefined;
      throw error;
    } finally {
      deciding.delete(approvalId);
    }
    waiting.get(approvalId)?.(approved && !cancelled);
    return true;
  }

  async function recordExecution(input: {
    toolCallId: string;
    goalId?: string;
    taskId?: string;
    conversationId?: string;
    automationId?: string;
    ok: boolean;
    summary: string;
  }) {
    const approval = [...approvals.values()].reverse().find((item) =>
      item.toolCallId === input.toolCallId && item.status === "approved" && !item.executionStatus &&
      item.goalId === input.goalId && item.taskId === input.taskId &&
      item.conversationId === input.conversationId && item.automationId === input.automationId
    );
    if (!approval) return false;
    const previous = { executionStatus: approval.executionStatus, resultSummary: approval.resultSummary, executedAt: approval.executedAt };
    approval.executionStatus = input.ok ? "succeeded" : "failed";
    approval.resultSummary = compactSummary(input.summary, 1000);
    approval.executedAt = now();
    try { await persistStore(); }
    catch (error) {
      approval.executionStatus = previous.executionStatus;
      approval.resultSummary = previous.resultSummary;
      approval.executedAt = previous.executedAt;
      throw error;
    }
    return true;
  }

  async function recover() {
    let changed = false;
    for (const approval of approvals.values()) {
      if (approval.status === "pending") {
        approval.status = "cancelled";
        approval.decidedAt = now();
        changed = true;
      } else if (approval.status === "approved" && approval.toolCallId && !approval.executionStatus) {
        approval.executionStatus = "interrupted";
        approval.resultSummary = "服务重启前未确认执行结果，请核对实际副作用。";
        changed = true;
      }
    }
    if (changed) await persistStore();
  }

  return { mode, request, decide, recordExecution, recover };
}

function compactSummary(value: string, limit = 32_000) {
  if (value.length <= limit) return value;
  const hash = createHash("sha256").update(value).digest("hex");
  return `${value.slice(0, limit - 120)}\n[后续 ${value.length - limit + 120} 字已省略；完整内容 SHA-256 ${hash}]`;
}

function summarizeArgs(args: Record<string, unknown>) {
  return JSON.stringify(args, (key, value) => {
    if (/password|token|secret|api.?key|credential|authorization/i.test(key) && value !== null && value !== undefined && value !== "") {
      throw new Error("工具参数包含凭据字段；请通过凭据代理处理，当前无法批准此操作");
    }
    return value;
  }) || "{}";
}
