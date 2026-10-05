import assert from "node:assert/strict";
import { it } from "node:test";
import { createAttentionService } from "../server/attention/service.js";
import type { Approval, AttentionState, Automation, Goal } from "../server/domain/types.js";

it("shows actionable events first, honors reminder mode and persists read decisions", async () => {
  const state: AttentionState = { mode: "important", readIds: [] };
  const goal: Goal = {
    id: "goal_1", projectId: "project_1", conversationId: "conversation_1", title: "研究目标", description: "",
    status: "active", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", tasks: [],
    activity: [
      { id: "completed_1", kind: "completed", text: "已完成初稿", createdAt: "2026-10-01T01:00:00.000Z" },
      { id: "interrupted_1", kind: "interrupted", text: "需要核对副作用", createdAt: "2026-10-01T02:00:00.000Z" }
    ],
    reviews: [{ id: "review_1", taskId: "task_1", runCount: 1, summary: "初稿完成", createdAt: "2026-10-01T03:00:00.000Z", suggestions: [{ id: "suggestion_1", title: "核对来源", instruction: "检查", reason: "待验证", status: "pending" }] }]
  };
  const approval: Approval = { id: "approval_1", goalId: goal.id, toolName: "write_file", riskLevel: "write", summary: "写入报告", status: "pending", createdAt: "2026-10-01T04:00:00.000Z" };
  const automation: Automation = { id: "automation_1", title: "日报", schedule: "每天 09:00", prompt: "整理", enabled: true, createdAt: "2026-10-01T00:00:00.000Z", runs: [{ id: "run_1", trigger: "schedule", status: "success", startedAt: "2026-10-01T05:00:00.000Z" }] };
  let writes = 0;
  const service = createAttentionService({ state, goals: new Map([[goal.id, goal]]), approvals: new Map([[approval.id, approval]]), automations: new Map([[automation.id, automation]]), persistStore: async () => { writes++; } });
  assert.equal(service.snapshot().items.length, 5);
  assert.equal(service.snapshot().unreadAlertCount, 3);
  assert.equal(await service.markRead("approval:approval_1"), true);
  assert.equal(service.snapshot().unreadAlertCount, 2);
  assert.equal(await service.markRead("missing"), false);
  await service.setMode("all");
  assert.equal(service.snapshot().unreadAlertCount, 4);
  await service.markAllRead();
  assert.equal(service.snapshot().unreadAlertCount, 0);
  await service.setMode("off");
  assert.equal(service.snapshot().unreadAlertCount, 0);
  assert.ok(writes >= 4);
});
