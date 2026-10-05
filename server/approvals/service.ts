import type { Approval } from "../domain/types.js";

type Input = {
  goalId?: string;
  taskId?: string;
  conversationId?: string;
  automationId?: string;
  toolName: string;
  riskLevel: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
};

export function createApprovalService(deps: {
  approvals: Map<string, Approval>;
  persistStore: () => Promise<void>;
  id: (prefix: string) => string;
  now: () => string;
  describeAction?: (input: Input) => Promise<string | undefined>;
}) {
  const { approvals, persistStore, id, now, describeAction } = deps;
  const waiting = new Map<string, (approved: boolean) => void>();
  const deciding = new Set<string>();

  async function request(input: Input): Promise<boolean> {
    if (input.signal?.aborted) return false;
    const detail = await describeAction?.(input);
    if (input.signal?.aborted) return false;
    const summary = [detail, summarizeArgs(input.args)].filter(Boolean).join("\n");
    if (summary.length > 32_000) throw new Error("审批内容超过 32000 字符，请拆分工具操作后重试");
    const approval: Approval = {
      id: id("approval"),
      goalId: input.goalId,
      taskId: input.taskId,
      conversationId: input.conversationId,
      automationId: input.automationId,
      toolName: input.toolName,
      riskLevel: input.riskLevel,
      summary,
      status: "pending",
      createdAt: now()
    };
    approvals.set(approval.id, approval);
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
    try {
      await persistStore();
    } catch (error) {
      approval.status = "pending";
      approval.decidedAt = undefined;
      throw error;
    } finally {
      deciding.delete(approvalId);
    }
    waiting.get(approvalId)?.(approved && !cancelled);
    return true;
  }

  async function recover() {
    let changed = false;
    for (const approval of approvals.values()) {
      if (approval.status !== "pending") continue;
      approval.status = "cancelled";
      approval.decidedAt = now();
      changed = true;
    }
    if (changed) await persistStore();
  }

  return { request, decide, recover };
}

function summarizeArgs(args: Record<string, unknown>) {
  return JSON.stringify(args, (key, value) => {
    if (/password|token|secret|api.?key|credential|authorization/i.test(key) && value !== null && value !== undefined && value !== "") {
      throw new Error("工具参数包含凭据字段；请通过凭据代理处理，当前无法批准此操作");
    }
    return value;
  }) || "{}";
}
