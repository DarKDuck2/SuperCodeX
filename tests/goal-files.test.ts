import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureGoalFiles, pruneGoalFileSnapshots, resolveGoalFile } from "../server/goals/files.js";
import type { Goal } from "../server/domain/types.js";

test("goal files track generated paths and reject protected or escaping files", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-goal-files-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-outside-"));
  const snapshotRoot = path.join(workspace, ".supercodex", "goal-files");
  try {
    await fs.writeFile(path.join(workspace, "report.md"), "first");
    await fs.writeFile(path.join(workspace, ".env"), "secret");
    await fs.writeFile(path.join(outside, "elsewhere.txt"), "outside");
    await fs.symlink(path.join(outside, "elsewhere.txt"), path.join(workspace, "escape.txt"));
    const goal: Goal = { id: "goal_1", projectId: "project_1", conversationId: "conversation_1", title: "研究", description: "", status: "active", createdAt: "now", updatedAt: "now", tasks: [], activity: [] };
    const input = { goal, taskId: "task_1", toolName: "write_file", workspacePath: workspace, snapshotRoot, id: () => "file_1", now: () => "2026-10-05T00:00:00Z" };
    const captured = await captureGoalFiles({ ...input, result: { ok: true, artifacts: [
      { title: "报告", path: "report.md", kind: "file" },
      { title: "密钥", path: ".env" },
      { title: "逃逸", path: "escape.txt" },
      { title: "外部", path: path.join(outside, "elsewhere.txt") }
    ] } });
    assert.equal(captured.length, 1);
    assert.equal(goal.files?.length, 1);
    assert.equal(goal.files?.[0].path, "report.md");
    assert.equal(goal.files?.[0].revision, 1);
    assert.equal(goal.files?.[0].snapshotSha256?.length, 64);
    const firstSnapshot = await resolveGoalFile(goal, "file_1", workspace, snapshotRoot);
    assert.equal(firstSnapshot?.snapshot, true);
    assert.equal(await fs.readFile(firstSnapshot!.absolutePath, "utf-8"), "first");

    await fs.writeFile(path.join(workspace, "report.md"), "second version");
    assert.equal(await fs.readFile((await resolveGoalFile(goal, "file_1", workspace, snapshotRoot))!.absolutePath, "utf-8"), "first");
    await captureGoalFiles({ ...input, taskId: "task_2", result: { ok: true, artifacts: [{ title: "更新报告", path: "report.md", kind: "file" }] } });
    assert.equal(goal.files?.length, 1);
    assert.equal(goal.files?.[0].id, "file_1");
    assert.equal(goal.files?.[0].taskId, "task_2");
    assert.equal(goal.files?.[0].size, "second version".length);
    assert.equal(goal.files?.[0].revision, 2);
    assert.equal(goal.files?.[0].history?.[0].revision, 1);
    assert.equal(await fs.readFile((await resolveGoalFile(goal, "file_1", workspace, snapshotRoot, 1))!.absolutePath, "utf-8"), "first");
    await fs.rm(path.join(workspace, "report.md"));
    await fs.symlink(path.join(outside, "elsewhere.txt"), path.join(workspace, "report.md"));
    assert.equal(await fs.readFile((await resolveGoalFile(goal, "file_1", workspace, snapshotRoot))!.absolutePath, "utf-8"), "second version");
    assert.equal(await resolveGoalFile(goal, "file_1", workspace, snapshotRoot, 99), undefined);
    const currentSnapshotPath = path.join(snapshotRoot, goal.id, "file_1", "2");
    await fs.chmod(currentSnapshotPath, 0o644);
    await fs.writeFile(currentSnapshotPath, Buffer.alloc("second version".length, 88));
    assert.equal(await resolveGoalFile(goal, "file_1", workspace, snapshotRoot), undefined);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("goal file history retains 20 snapshots and prunes older bytes", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-goal-history-"));
  const snapshotRoot = path.join(workspace, ".supercodex", "goal-files");
  try {
    const goal: Goal = { id: "goal_2", projectId: "project_1", conversationId: "conversation_1", title: "研究", description: "", status: "active", createdAt: "now", updatedAt: "now", tasks: [], activity: [] };
    const source = path.join(workspace, "report.md");
    for (let revision = 1; revision <= 24; revision++) {
      await fs.writeFile(source, `content ${revision}`);
      const previous = goal.files;
      await captureGoalFiles({ goal, taskId: `task_${revision}`, toolName: "write_file", result: { ok: true, artifacts: [{ title: "报告", path: "report.md" }] }, workspacePath: workspace, snapshotRoot, id: () => "file_2", now: () => String(revision) });
      await pruneGoalFileSnapshots(goal.id, previous, goal.files, snapshotRoot);
    }
    assert.equal(goal.files?.[0].revision, 24);
    assert.equal(goal.files?.[0].history?.length, 20);
    assert.equal(goal.files?.[0].history?.at(-1)?.revision, 4);
    await assert.rejects(fs.stat(path.join(snapshotRoot, goal.id, "file_2", "1")), { code: "ENOENT" });
    assert.equal(await fs.readFile((await resolveGoalFile(goal, "file_2", workspace, snapshotRoot, 4))!.absolutePath, "utf-8"), "content 4");
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});
