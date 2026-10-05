import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoalArtifactService, GoalArtifactError } from "../server/goals/artifacts.js";
import type { Goal } from "../server/domain/types.js";

function fixture(failAt?: number) {
  const goal: Goal = { id: "goal_1", projectId: "project_1", conversationId: "conversation_1", title: "研究", description: "", status: "active", createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", tasks: [], activity: [] };
  const goals = new Map([[goal.id, goal]]);
  let saves = 0;
  let nextId = 0;
  const service = createGoalArtifactService({
    goals,
    persistStore: async () => { saves++; if (saves === failAt) throw new Error("disk unavailable"); },
    id: (prefix) => `${prefix}_${++nextId}`,
    now: () => "2026-10-04T01:00:00.000Z"
  });
  return { service, goal, getSaves: () => saves };
}

test("goal artifacts keep revisions and reject stale concurrent edits", async () => {
  const f = fixture();
  const created = await f.service.create(f.goal.id, { title: "持续报告", content: "初稿", updatedBy: "user" });
  assert.equal(created.revision, 1);
  const [first, second] = await Promise.allSettled([
    f.service.update(f.goal.id, created.id, { expectedRevision: 1, title: "持续报告", content: "第一版修改", updatedBy: "agent" }),
    f.service.update(f.goal.id, created.id, { expectedRevision: 1, title: "持续报告", content: "过期修改", updatedBy: "user" })
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.ok(second.status === "rejected" && second.reason instanceof GoalArtifactError && second.reason.status === 409);
  assert.equal(f.service.list(f.goal.id)[0].content, "第一版修改");
  assert.equal(f.service.list(f.goal.id)[0].revision, 2);
  assert.equal(f.service.list(f.goal.id)[0].updatedBy, "agent");
  assert.deepEqual(f.service.list(f.goal.id)[0].history?.map((version) => [version.revision, version.content, version.updatedBy]), [[1, "初稿", "user"]]);
  const restored = await f.service.restore(f.goal.id, created.id, 2, 1);
  assert.equal(restored.revision, 3);
  assert.equal(restored.content, "初稿");
  assert.equal(restored.updatedBy, "user");
  assert.equal(restored.restoredFromRevision, 1);
  assert.deepEqual(restored.history?.map((version) => [version.revision, version.content, version.updatedBy]), [[2, "第一版修改", "agent"], [1, "初稿", "user"]]);
  await assert.rejects(f.service.restore(f.goal.id, created.id, 2, 1), /重新载入/);
  await assert.rejects(f.service.restore(f.goal.id, created.id, 3, 99), /不存在/);
  await assert.rejects(f.service.remove(f.goal.id, created.id, 1), /重新载入/);
  await f.service.remove(f.goal.id, created.id, 3);
  assert.deepEqual(f.service.list(f.goal.id), []);
});

test("artifact writes restore memory state after persistence fails", async () => {
  const f = fixture(2);
  const created = await f.service.create(f.goal.id, { title: "清单", content: "A", updatedBy: "user" });
  await assert.rejects(f.service.update(f.goal.id, created.id, { expectedRevision: 1, title: "清单", content: "B", updatedBy: "agent" }), /disk unavailable/);
  assert.equal(f.service.list(f.goal.id)[0].content, "A");
  assert.equal(f.service.list(f.goal.id)[0].revision, 1);
  const updated = await f.service.update(f.goal.id, created.id, { expectedRevision: 1, title: "清单", content: "C", updatedBy: "user" });
  assert.equal(updated.revision, 2);
});

test("artifact restore rolls back on persistence failure and retains only recent versions", async () => {
  const f = fixture(3);
  const created = await f.service.create(f.goal.id, { title: "清单", content: "A", updatedBy: "user" });
  await f.service.update(f.goal.id, created.id, { expectedRevision: 1, title: "清单", content: "B", updatedBy: "agent" });
  await assert.rejects(f.service.restore(f.goal.id, created.id, 2, 1), /disk unavailable/);
  assert.equal(f.service.list(f.goal.id)[0].revision, 2);
  assert.equal(f.service.list(f.goal.id)[0].content, "B");
  for (let revision = 2; revision < 24; revision++) {
    await f.service.update(f.goal.id, created.id, { expectedRevision: revision, title: "清单", content: `版本 ${revision + 1}`, updatedBy: "user" });
  }
  const current = f.service.list(f.goal.id)[0];
  assert.equal(current.revision, 24);
  assert.equal(current.history?.length, 20);
  assert.equal(current.history?.[0].revision, 23);
  assert.equal(current.history?.at(-1)?.revision, 4);
  await assert.rejects(f.service.restore(f.goal.id, created.id, 24, 1), /超出保留范围/);
});
