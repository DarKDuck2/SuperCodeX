import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAutomationRunner } from "../server/automation/runner.js";
import type { Automation } from "../server/domain/types.js";

function fixture(failFirstPersist = false) {
  const automation: Automation = {
    id: "automation_1", title: "日报", schedule: "每2小时", prompt: "整理日报", enabled: true,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    lastStatus: "running", nextRunAt: "2026-10-01T01:00:00.000Z", unreadCount: 0,
    runs: [{ id: "run_1", trigger: "schedule", startedAt: "2026-10-01T00:00:00.000Z", status: "running" }]
  };
  const automations = new Map([[automation.id, automation]]);
  const runningAutomations = new Set<string>();
  let persistCount = 0;
  let agentCalls = 0;
  const runner = createAutomationRunner({
    automations, runningAutomations,
    persistStore: async () => { persistCount++; if (failFirstPersist && persistCount === 1) throw new Error("disk unavailable"); },
    getAutomationConversation: () => ({ id: "conversation_1", projectId: "project_1", title: "日报", updatedAt: "2026-10-01T00:00:00.000Z", messages: [] }),
    runAgentLoop: async () => { agentCalls++; throw new Error("Agent should not run"); },
    saveGeneratedTextAttachment: async () => { throw new Error("No attachment expected"); },
    publicAttachment: () => { throw new Error("No attachment expected"); },
    id: () => "run_2",
    now: () => new Date().toISOString()
  });
  return { automation, runner, runningAutomations, getAgentCalls: () => agentCalls };
}

describe("automation recovery", () => {
  it("marks an in-flight run interrupted and moves its next schedule forward", async () => {
    const f = fixture();
    await f.runner.recover();
    assert.equal(f.automation.lastStatus, "error");
    assert.equal(f.automation.runs?.[0]?.status, "error");
    assert.match(f.automation.lastError || "", /检查已产生的操作/);
    assert.equal(f.automation.unreadCount, 1);
    assert.ok(f.automation.nextRunAt && Date.parse(f.automation.nextRunAt) > Date.now());
    await f.runner.recover();
    assert.equal(f.automation.unreadCount, 1);
    assert.equal(f.getAgentCalls(), 0);
  });

  it("does not start Agent work when the run start cannot be persisted", async () => {
    const f = fixture(true);
    await f.runner.runAutomation(f.automation, "manual");
    assert.equal(f.getAgentCalls(), 0);
    assert.equal(f.automation.lastStatus, "error");
    assert.equal(f.runningAutomations.size, 0);
  });
});
