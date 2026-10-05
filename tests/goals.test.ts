import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGoalService } from "../server/goals/service.js";
import { parseGoalReviewResponse, type GoalReviewDraft } from "../server/goals/review.js";
import { createApprovalService } from "../server/approvals/service.js";
import { runRegisteredTool } from "../server/tools/runtime.js";
import type { GitHubReleaseResult } from "../server/connectors/github-releases.js";
import type { CalendarEvent } from "../server/connectors/google-calendar.js";
import type { AgentRunOptions, Conversation, Goal } from "../server/domain/types.js";
import type { RegisteredTool } from "../server/tools/types.js";

function fixture(projectRoot?: string, simulateDeniedApproval = false, failPersistAt?: number, suggestNextSteps?: () => Promise<GoalReviewDraft | undefined>, onRun?: (conversation: Conversation, beforeToolExecute: NonNullable<AgentRunOptions["beforeToolExecute"]>, afterToolExecute: NonNullable<AgentRunOptions["afterToolExecute"]>) => Promise<void>, getGitHubReleases?: (repo: string, etag?: string) => Promise<GitHubReleaseResult>, getCalendarEvents?: (timeMin: string, timeMax: string) => Promise<CalendarEvent[]>) {
  const goals = new Map<string, Goal>();
  const conversations = new Map<string, Conversation>();
  const projects = new Map([["project_1", { id: "project_1", name: "测试项目", rootPath: projectRoot, conversations: [] }]]);
  let nextId = 0;
  let executions = 0;
  let persistCount = 0;
  const id = (prefix: string) => `${prefix}_${++nextId}`;
  const now = () => "2026-10-03T00:00:00.000Z";
  const persistStore = async () => {
    persistCount++;
    if (persistCount === failPersistAt) throw new Error("disk unavailable");
  };
  const createConversation = (projectId: string, title: string) => {
    const conversation: Conversation = { id: id("conversation"), projectId, title, updatedAt: now(), messages: [] };
    conversations.set(conversation.id, conversation);
    return conversation;
  };
  const service = createGoalService({
    goals,
    snapshotRoot: projectRoot ? path.join(projectRoot, ".supercodex", "goal-files") : undefined,
    conversations,
    projects,
    createConversation,
    runAgentLoop: async (conversation, _onEvent, _signal, authorizeTool, beforeToolExecute, afterToolExecute) => {
      executions++;
      if (onRun) await onRun(conversation, beforeToolExecute, afterToolExecute);
      if (simulateDeniedApproval) await authorizeTool({ toolName: "write_file", riskLevel: "write", args: { path: "result.md" } });
      const finalMessage = { id: id("message"), role: "assistant" as const, content: "已形成报告", createdAt: now() };
      conversation.messages.push(finalMessage);
      return { finalMessage, turns: 1, toolCalls: [] };
    },
    requestApproval: async () => false,
    getGitHubReleases,
    getCalendarEvents,
    suggestNextSteps,
    persistStore,
    id,
    now
  });
  return { service, goals, conversations, getExecutions: () => executions, getPersistCount: () => persistCount };
}

describe("persistent goals", () => {
  it("runs different goals concurrently while serializing steps in one goal", { timeout: 3000 }, async () => {
    const releases: Array<() => void> = [];
    const activeConversations = new Set<string>();
    let maxActive = 0;
    let overlapInOneGoal = false;
    const f = fixture(undefined, false, undefined, undefined, async (conversation) => {
      if (activeConversations.has(conversation.id)) overlapInOneGoal = true;
      activeConversations.add(conversation.id);
      maxActive = Math.max(maxActive, activeConversations.size);
      await new Promise<void>((resolve) => releases.push(resolve));
      activeConversations.delete(conversation.id);
    });
    const firstGoal = await f.service.createGoal({ projectId: "project_1", title: "目标一", description: "" });
    const secondGoal = await f.service.createGoal({ projectId: "project_1", title: "目标二", description: "" });
    const firstTask = await f.service.addTask(firstGoal, { title: "第一步", instruction: "执行" });
    const secondTask = await f.service.addTask(firstGoal, { title: "第二步", instruction: "执行" });
    const otherTask = await f.service.addTask(secondGoal, { title: "另一目标", instruction: "执行" });
    await f.service.queueTask(firstGoal, firstTask);
    await f.service.queueTask(firstGoal, secondTask);
    await f.service.queueTask(secondGoal, otherTask);
    await waitFor(() => releases.length === 2);
    assert.equal(maxActive, 2);
    assert.equal(secondTask.status, "queued");
    assert.equal(overlapInOneGoal, false);
    releases.shift()?.();
    await waitFor(() => releases.length === 2);
    assert.equal(overlapInOneGoal, false);
    releases.splice(0).forEach((release) => release());
    await f.service.pump();
    assert.equal(firstTask.status, "completed");
    assert.equal(secondTask.status, "completed");
    assert.equal(otherTask.status, "completed");
  });

  it("runs a queued step independently of a browser response and records its outcome", async () => {
    const f = fixture();
    const goal = await f.service.createGoal({ projectId: "project_1", title: "跟进岗位", description: "每周整理机会" });
    const task = await f.service.addTask(goal, { title: "收集机会", instruction: "整理本周新岗位" });
    await f.service.queueTask(goal, task);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(task.status, "completed");
    assert.equal(task.result, "已形成报告");
    assert.equal(f.getExecutions(), 1);
    assert.ok(f.getPersistCount() >= 4);
    assert.ok(goal.activity.some((event) => event.kind === "completed" && event.taskId === task.id));
    assert.equal(f.conversations.get(goal.conversationId)?.messages[0]?.role, "user");
  });

  it("marks an in-flight step interrupted after restart instead of silently repeating side effects", async () => {
    const f = fixture();
    const goal = await f.service.createGoal({ projectId: "project_1", title: "跟进邮件", description: "" });
    const task = await f.service.addTask(goal, { title: "检查邮件", instruction: "读取邮件" });
    goal.status = "paused";
    task.status = "running";
    await f.service.recover();
    assert.equal(task.status, "interrupted");
    assert.match(task.error || "", /重启中断/);
    assert.equal(f.getExecutions(), 0);
  });

  it("requeues an unfinished planning attempt without repeating its synthetic message", async () => {
    const f = fixture();
    const goal = await f.service.createGoal({ projectId: "project_1", title: "安全恢复", description: "" });
    const task = await f.service.addTask(goal, { title: "整理资料", instruction: "先规划" });
    const conversation = f.conversations.get(goal.conversationId)!;
    conversation.messages.push({ id: "old_prompt", role: "user", content: "旧执行提示", createdAt: "2026-10-03T00:00:00.000Z" });
    task.status = "running";
    task.checkpoint = { attemptId: "old_attempt", messageId: "old_prompt", phase: "planning", updatedAt: "2026-10-03T00:00:00.000Z" };
    await f.service.recover();
    await waitFor(() => task.status === "completed");
    assert.equal(f.getExecutions(), 1);
    assert.equal(conversation.messages.filter((message) => message.role === "user").length, 1);
    assert.ok(!conversation.messages.some((message) => message.id === "old_prompt"));
  });

  it("keeps a tool-stage attempt interrupted for manual review after restart", async () => {
    const f = fixture();
    const goal = await f.service.createGoal({ projectId: "project_1", title: "安全恢复", description: "" });
    const task = await f.service.addTask(goal, { title: "写文件", instruction: "保存" });
    const conversation = f.conversations.get(goal.conversationId)!;
    conversation.messages.push({ id: "old_prompt", role: "user", content: "旧执行提示", createdAt: "2026-10-03T00:00:00.000Z" });
    task.status = "running";
    task.checkpoint = { attemptId: "old_attempt", messageId: "old_prompt", phase: "tool_started", firstToolName: "write_file", updatedAt: "2026-10-03T00:00:00.000Z" };
    await f.service.recover();
    assert.equal(task.status, "interrupted");
    assert.match(task.error || "", /write_file/);
    assert.equal(f.getExecutions(), 0);
  });

  it("repairs missing tool replies after restart without repeating an action", async () => {
    const f = fixture();
    const goal = await f.service.createGoal({ projectId: "project_1", title: "恢复会话", description: "" });
    const task = await f.service.addTask(goal, { title: "写两份文件", instruction: "执行" });
    const conversation = f.conversations.get(goal.conversationId)!;
    conversation.messages.push(
      { id: "old_prompt", role: "user", content: "旧执行提示", createdAt: "2026-10-03T00:00:00.000Z" },
      { id: "old_calls", role: "assistant", content: "", createdAt: "2026-10-03T00:00:00.000Z", tool_calls: [
        { id: "call_one", type: "function", function: { name: "write_file", arguments: "{}" } },
        { id: "call_two", type: "function", function: { name: "write_file", arguments: "{}" } }
      ] },
      { id: "first_result", role: "tool", content: "已写入", tool_call_id: "call_one", toolName: "write_file", createdAt: "2026-10-03T00:00:00.000Z" }
    );
    task.status = "running";
    task.checkpoint = { attemptId: "old_attempt", messageId: "old_prompt", phase: "tool_started", firstToolName: "write_file", lastToolName: "write_file", toolCount: 2, completedToolCount: 1, lastToolOutcome: "unknown", updatedAt: "2026-10-03T00:00:00.000Z" };
    await f.service.recover();
    assert.equal(task.status, "interrupted");
    assert.equal(f.getExecutions(), 0);
    const replies = conversation.messages.filter((message) => message.role === "tool");
    assert.deepEqual(replies.map((message) => message.tool_call_id), ["call_one", "call_two"]);
    assert.match(replies[1].content, /执行状态未知/);
    await f.service.recover();
    assert.equal(conversation.messages.filter((message) => message.role === "tool").length, 2);
  });

  it("repairs an orphan model tool call even when no tool checkpoint began", async () => {
    const f = fixture();
    const goal = await f.service.createGoal({ projectId: "project_1", title: "规划中断", description: "" });
    const task = await f.service.addTask(goal, { title: "待执行", instruction: "执行" });
    const conversation = f.conversations.get(goal.conversationId)!;
    conversation.messages.push(
      { id: "old_prompt", role: "user", content: "旧执行提示", createdAt: "2026-10-03T00:00:00.000Z" },
      { id: "old_call", role: "assistant", content: "", createdAt: "2026-10-03T00:00:00.000Z", tool_calls: [
        { id: "call_pending", type: "function", function: { name: "read_file", arguments: "{}" } }
      ] }
    );
    task.status = "running";
    task.checkpoint = { attemptId: "old_attempt", messageId: "old_prompt", phase: "planning", updatedAt: "2026-10-03T00:00:00.000Z" };
    await f.service.recover();
    assert.equal(task.status, "interrupted");
    assert.ok(conversation.messages.some((message) => message.role === "tool" && message.tool_call_id === "call_pending"));
    assert.equal(f.getExecutions(), 0);
  });

  it("persists a tool checkpoint before invoking the goal tool", async () => {
    let phaseAtTool = "";
    const f = fixture(undefined, false, undefined, undefined, async (_conversation, beforeToolExecute) => {
      await beforeToolExecute({ toolName: "read_file", riskLevel: "read", args: { path: "report.md" } });
      phaseAtTool = [...f.goals.values()][0].tasks[0].checkpoint?.phase || "";
    });
    const goal = await f.service.createGoal({ projectId: "project_1", title: "检查点", description: "" });
    const task = await f.service.addTask(goal, { title: "读取资料", instruction: "读取" });
    await f.service.queueTask(goal, task);
    await f.service.pump();
    assert.equal(phaseAtTool, "tool_started");
    assert.equal(task.checkpoint?.phase, "finished");
    assert.equal(task.checkpoint?.firstToolName, "read_file");
  });

  it("persists a new checkpoint before every tool, including later calls", async () => {
    const counts: number[] = [];
    const f = fixture(undefined, false, undefined, undefined, async (_conversation, beforeToolExecute) => {
      await beforeToolExecute({ toolName: "read_file", riskLevel: "read", args: { path: "source.md" } });
      counts.push(f.getPersistCount());
      await beforeToolExecute({ toolName: "write_file", riskLevel: "write", args: { path: "report.md" } });
      counts.push(f.getPersistCount());
    });
    const goal = await f.service.createGoal({ projectId: "project_1", title: "逐次检查点", description: "" });
    const task = await f.service.addTask(goal, { title: "读取并写入", instruction: "执行" });
    await f.service.queueTask(goal, task);
    await f.service.pump();
    assert.equal(counts[1], counts[0] + 1);
    assert.equal(task.checkpoint?.firstToolName, "read_file");
    assert.equal(task.checkpoint?.lastToolName, "write_file");
    assert.equal(task.checkpoint?.toolCount, 2);
  });

  it("stops a later tool when its checkpoint cannot be saved", async () => {
    let reachedSecondTool = false;
    const f = fixture(undefined, false, 6, undefined, async (_conversation, beforeToolExecute) => {
      await beforeToolExecute({ toolName: "read_file", riskLevel: "read", args: {} });
      await beforeToolExecute({ toolName: "write_file", riskLevel: "write", args: {} });
      reachedSecondTool = true;
    });
    const goal = await f.service.createGoal({ projectId: "project_1", title: "失败检查点", description: "" });
    const task = await f.service.addTask(goal, { title: "第二工具", instruction: "执行" });
    await f.service.queueTask(goal, task);
    await f.service.pump();
    assert.equal(reachedSecondTool, false);
    assert.equal(task.status, "interrupted");
    assert.match(task.error || "", /disk unavailable/);
  });

  it("records each tool outcome before continuing the goal", async () => {
    let outcomeAtResume = "";
    const f = fixture(undefined, false, undefined, undefined, async (_conversation, beforeToolExecute, afterToolExecute) => {
      await beforeToolExecute({ toolName: "write_file", riskLevel: "write", args: {} });
      assert.equal([...f.goals.values()][0].tasks[0].checkpoint?.lastToolOutcome, "unknown");
      await afterToolExecute({ toolName: "write_file", riskLevel: "write", args: {}, toolCallId: "call_write", result: { ok: true } });
      outcomeAtResume = [...f.goals.values()][0].tasks[0].checkpoint?.lastToolOutcome || "";
    });
    const goal = await f.service.createGoal({ projectId: "project_1", title: "结果检查点", description: "" });
    const task = await f.service.addTask(goal, { title: "写入", instruction: "执行" });
    await f.service.queueTask(goal, task);
    await f.service.pump();
    assert.equal(outcomeAtResume, "succeeded");
    assert.equal(task.checkpoint?.completedToolCount, 1);
    assert.equal(task.checkpoint?.lastToolCallId, "call_write");
  });

  it("requires manual review when saving a completed tool result fails", async () => {
    let resumedAfterResult = false;
    const f = fixture(undefined, false, 6, undefined, async (_conversation, beforeToolExecute, afterToolExecute) => {
      await beforeToolExecute({ toolName: "write_file", riskLevel: "write", args: {} });
      await afterToolExecute({ toolName: "write_file", riskLevel: "write", args: {}, toolCallId: "call_written", result: { ok: true } });
      resumedAfterResult = true;
    });
    const goal = await f.service.createGoal({ projectId: "project_1", title: "保存失败", description: "" });
    const task = await f.service.addTask(goal, { title: "写入", instruction: "执行" });
    await f.service.queueTask(goal, task);
    await f.service.pump();
    assert.equal(resumedAfterResult, false);
    assert.equal(task.status, "interrupted");
    assert.match(task.error || "", /工具阶段出错：disk unavailable/);
  });

  it("does not retain a goal file entry when its tool result checkpoint fails", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-goal-checkpoint-"));
    try {
      await fs.writeFile(path.join(workspace, "report.md"), "result");
      const f = fixture(workspace, false, 6, undefined, async (_conversation, beforeToolExecute, afterToolExecute) => {
        await beforeToolExecute({ toolName: "write_file", riskLevel: "write", args: {} });
        await afterToolExecute({ toolName: "write_file", riskLevel: "write", args: {}, toolCallId: "call_file", result: { ok: true, artifacts: [{ title: "报告", path: "report.md" }] } });
      });
      const goal = await f.service.createGoal({ projectId: "project_1", title: "文件检查点", description: "" });
      const task = await f.service.addTask(goal, { title: "写入", instruction: "执行" });
      await f.service.queueTask(goal, task);
      await f.service.pump();
      assert.equal(task.status, "interrupted");
      assert.equal(goal.files, undefined);
      assert.equal(await fs.readFile(path.join(workspace, "report.md"), "utf-8"), "result");
      const fileFolders = await fs.readdir(path.join(workspace, ".supercodex", "goal-files", goal.id));
      assert.equal(fileFolders.length, 1);
      assert.deepEqual(await fs.readdir(path.join(workspace, ".supercodex", "goal-files", goal.id, fileFolders[0])), []);
    } finally { await fs.rm(workspace, { recursive: true, force: true }); }
  });

  it("starts a scheduled goal step when its saved next-run time is due", async () => {
    const f = fixture();
    const goal = await f.service.createGoal({ projectId: "project_1", title: "每日研究", description: "" });
    const task = await f.service.addTask(goal, { title: "更新资料", instruction: "检查变化", schedule: "每天 09:00" });
    task.nextRunAt = "2026-01-01T00:00:00.000Z";
    await f.service.runDueTasks();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(task.status, "completed");
    assert.equal(f.getExecutions(), 1);
    assert.ok(task.nextRunAt && Date.parse(task.nextRunAt) > Date.now());
  });

  it("starts once for a new GitHub release and persists the release cursor with the queue", async () => {
    let calls = 0;
    const first = { id: 1, tag: "v1", title: "旧版本", url: "https://github.com/example/repo/releases/tag/v1" };
    const second = { id: 2, tag: "v2", title: "新版本", url: "https://github.com/example/repo/releases/tag/v2" };
    const f = fixture(undefined, false, undefined, undefined, undefined, async () => {
      calls++;
      return { releases: calls === 1 ? [first] : [second, first], etag: `etag-${calls}`, notModified: false };
    });
    const goal = await f.service.createGoal({ projectId: "project_1", title: "跟踪版本", description: "" });
    const task = await f.service.addTask(goal, { title: "检查更新", instruction: "总结变化", githubRepo: "Example/Repo" });
    assert.equal(task.githubReleaseTrigger?.repo, "example/repo");
    assert.deepEqual(task.githubReleaseTrigger?.seenIds, [1]);
    task.githubReleaseTrigger!.nextCheckAt = "2026-01-01T00:00:00.000Z";
    await f.service.runDueTasks();
    await f.service.pump();
    assert.equal(task.status, "completed");
    assert.deepEqual(task.githubReleaseTrigger?.seenIds, [2, 1]);
    assert.match(f.conversations.get(goal.conversationId)?.messages.find((message) => message.role === "user")?.content || "", /v2/);
    task.githubReleaseTrigger!.nextCheckAt = "2026-01-01T00:00:00.000Z";
    await f.service.runDueTasks();
    assert.equal(task.status, "completed");
    assert.equal(f.getExecutions(), 1);
  });

  it("does not consume a release event when queue persistence fails", async () => {
    let calls = 0;
    const f = fixture(undefined, false, 3, undefined, undefined, async () => {
      calls++;
      return {
        releases: calls === 1
          ? [{ id: 1, tag: "v1", title: "旧版本", url: "https://github.com/example/repo/releases/tag/v1" }]
          : [{ id: 2, tag: "v2", title: "新版本", url: "https://github.com/example/repo/releases/tag/v2" }],
        etag: `etag-${calls}`, notModified: false
      };
    });
    const goal = await f.service.createGoal({ projectId: "project_1", title: "跟踪版本", description: "" });
    const task = await f.service.addTask(goal, { title: "检查更新", instruction: "总结变化", githubRepo: "example/repo" });
    task.githubReleaseTrigger!.nextCheckAt = "2026-01-01T00:00:00.000Z";
    await assert.rejects(f.service.runDueTasks(), /disk unavailable/);
    assert.equal(task.status, "planned");
    assert.deepEqual(task.githubReleaseTrigger?.seenIds, [1]);
    assert.equal(task.triggerContext, undefined);
    assert.equal(f.getExecutions(), 0);
  });

  it("queues only new or updated Google Calendar events and remembers them across polls", async () => {
    const existing = { id: "meeting-1", summary: "已有会议", start: "2026-10-05T09:00:00Z", end: "2026-10-05T09:30:00Z", updated: "2026-10-02T12:00:00Z" };
    const updated = { ...existing, summary: "调整后的会议", updated: "2026-10-03T01:00:00Z" };
    const added = { id: "meeting-2", summary: "新增会议", start: "2026-10-05T10:00:00Z", end: "2026-10-05T10:30:00Z", updated: "2026-10-03T02:00:00Z" };
    let calls = 0;
    const f = fixture(undefined, false, undefined, undefined, undefined, undefined, async () => {
      calls++;
      return calls === 1 ? [existing] : [updated, added];
    });
    const goal = await f.service.createGoal({ projectId: "project_1", title: "会议跟进", description: "留意日程变化" });
    const task = await f.service.addTask(goal, { title: "整理变更", instruction: "处理会议变化", calendarEvents: true });
    assert.equal(task.calendarEventTrigger?.seenVersions.length, 1);
    task.calendarEventTrigger!.nextCheckAt = "2026-01-01T00:00:00Z";
    await f.service.runDueTasks();
    await f.service.pump();
    assert.equal(task.status, "completed");
    assert.equal(f.getExecutions(), 1);
    assert.equal(task.calendarEventTrigger?.seenVersions.length, 3);
    const prompt = f.conversations.get(goal.conversationId)?.messages.find((message) => message.role === "user")?.content || "";
    assert.match(prompt, /调整后的会议/);
    assert.match(prompt, /新增会议/);
    task.calendarEventTrigger!.nextCheckAt = "2026-01-01T00:00:00Z";
    await f.service.runDueTasks();
    assert.equal(f.getExecutions(), 1);
    const resumed = fixture(undefined, false, undefined, undefined, undefined, undefined, async () => [updated, added]);
    const restoredGoal = JSON.parse(JSON.stringify(goal)) as Goal;
    const restoredConversation = JSON.parse(JSON.stringify(f.conversations.get(goal.conversationId))) as Conversation;
    resumed.goals.set(restoredGoal.id, restoredGoal);
    resumed.conversations.set(restoredConversation.id, restoredConversation);
    restoredGoal.tasks[0].calendarEventTrigger!.nextCheckAt = "2026-01-01T00:00:00Z";
    await resumed.service.runDueTasks();
    assert.equal(resumed.getExecutions(), 0);
  });

  it("does not consume a calendar change when queue persistence fails", async () => {
    let calls = 0;
    const f = fixture(undefined, false, 3, undefined, undefined, undefined, async () => {
      calls++;
      return calls === 1 ? [] : [{ id: "meeting-1", summary: "新会议", start: "2026-10-05T09:00:00Z", end: "2026-10-05T09:30:00Z", updated: "2026-10-03T01:00:00Z" }];
    });
    const goal = await f.service.createGoal({ projectId: "project_1", title: "会议跟进", description: "" });
    const task = await f.service.addTask(goal, { title: "整理变更", instruction: "处理会议变化", calendarEvents: true });
    task.calendarEventTrigger!.nextCheckAt = "2026-01-01T00:00:00Z";
    await assert.rejects(f.service.runDueTasks(), /disk unavailable/);
    assert.equal(task.status, "planned");
    assert.deepEqual(task.calendarEventTrigger?.seenVersions, []);
    assert.equal(task.triggerContext, undefined);
    assert.equal(f.getExecutions(), 0);
  });

  it("runs once when a watched workspace file changes and rejects paths outside the workspace", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-goal-test-"));
    const watched = path.join(dir, "input.txt");
    await fs.writeFile(watched, "a");
    try {
      const f = fixture(dir);
      const goal = await f.service.createGoal({ projectId: "project_1", title: "文件跟进", description: "" });
      await assert.rejects(f.service.addTask(goal, { title: "非法路径", instruction: "读取", watchPath: "../outside.txt" }), /outside workspace/);
      const task = await f.service.addTask(goal, { title: "文件变化", instruction: "读取", watchPath: "input.txt" });
      await fs.writeFile(watched, "updated content");
      await f.service.runDueTasks();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(f.getExecutions(), 1);
      assert.equal(task.status, "completed");
      await f.service.runDueTasks();
      assert.equal(f.getExecutions(), 1);
    } finally {
      await fs.unlink(watched);
      await fs.rmdir(dir);
    }
  });

  it("does not mark a goal step complete when an action was rejected", async () => {
    const f = fixture(undefined, true);
    const goal = await f.service.createGoal({ projectId: "project_1", title: "写报告", description: "" });
    const task = await f.service.addTask(goal, { title: "保存报告", instruction: "写入结果" });
    await f.service.queueTask(goal, task);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(task.status, "interrupted");
    assert.match(task.error || "", /未获批准/);
  });

  it("allows plan revision before execution and preserves completed step history", async () => {
    const f = fixture();
    const goal = await f.service.createGoal({ projectId: "project_1", title: "持续研究", description: "" });
    const task = await f.service.addTask(goal, { title: "旧计划", instruction: "旧说明" });
    await f.service.updateTask(goal, task, { title: "核对来源", instruction: "记录发布日期和原文" });
    assert.equal(task.title, "核对来源");
    assert.equal(task.instruction, "记录发布日期和原文");
    assert.ok(goal.activity.some((event) => event.text.includes("已修订步骤")));
    await f.service.queueTask(goal, task);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(f.service.updateTask(goal, task, { title: "再次修改", instruction: "覆盖历史" }), /仅可修改/);
    assert.equal(task.title, "核对来源");
  });

  it("reorders unfinished steps while keeping completed and queued slots fixed", async () => {
    const f = fixture();
    const goal = await f.service.createGoal({ projectId: "project_1", title: "调整计划", description: "" });
    const first = await f.service.addTask(goal, { title: "第一步", instruction: "执行" });
    const completed = await f.service.addTask(goal, { title: "已完成", instruction: "保留历史" });
    const second = await f.service.addTask(goal, { title: "第二步", instruction: "执行" });
    const queued = await f.service.addTask(goal, { title: "已排队", instruction: "保留队列" });
    const third = await f.service.addTask(goal, { title: "第三步", instruction: "执行" });
    completed.status = "completed";
    queued.status = "queued";
    const revision = goal.planRevision!;
    await f.service.reorderTasks(goal, [third.id, second.id, first.id], revision);
    assert.deepEqual(goal.tasks.map((task) => task.id), [third.id, completed.id, second.id, queued.id, first.id]);
    assert.equal(goal.planRevision, revision + 1);
    assert.equal(completed.status, "completed");
    assert.equal(queued.status, "queued");
    assert.ok(goal.activity.some((activity) => activity.text.includes("已调整未完成步骤顺序")));
    await assert.rejects(f.service.reorderTasks(goal, [first.id, second.id, third.id], revision), /计划已经变化/);
    await assert.rejects(f.service.reorderTasks(goal, [first.id, first.id, third.id], goal.planRevision!), /步骤顺序/);
    await assert.rejects(f.service.reorderTasks(goal, [completed.id, second.id, third.id], goal.planRevision!), /步骤顺序/);
  });

  it("restores task order and plan revision when reordering cannot be persisted", async () => {
    const f = fixture(undefined, false, 4);
    const goal = await f.service.createGoal({ projectId: "project_1", title: "调整计划", description: "" });
    const first = await f.service.addTask(goal, { title: "第一步", instruction: "执行" });
    const second = await f.service.addTask(goal, { title: "第二步", instruction: "执行" });
    const revision = goal.planRevision!;
    await assert.rejects(f.service.reorderTasks(goal, [second.id, first.id], revision), /disk unavailable/);
    assert.deepEqual(goal.tasks.map((task) => task.id), [first.id, second.id]);
    assert.equal(goal.planRevision, revision);
    assert.equal(goal.activity.some((activity) => activity.text.includes("已调整未完成步骤顺序")), false);
  });

  it("does not retain an unsaved plan addition or edit after persistence fails", async () => {
    const addition = fixture(undefined, false, 2);
    const goal = await addition.service.createGoal({ projectId: "project_1", title: "草稿计划", description: "" });
    await assert.rejects(addition.service.addTask(goal, { title: "未保存", instruction: "不应出现" }), /disk unavailable/);
    assert.equal(goal.tasks.length, 0);
    assert.equal(goal.planRevision, 0);
    assert.equal(goal.activity.some((activity) => activity.text.includes("未保存")), false);

    const edit = fixture(undefined, false, 3);
    const otherGoal = await edit.service.createGoal({ projectId: "project_1", title: "已有计划", description: "" });
    const task = await edit.service.addTask(otherGoal, { title: "原名称", instruction: "原说明" });
    await assert.rejects(edit.service.updateTask(otherGoal, task, { title: "新名称", instruction: "新说明" }), /disk unavailable/);
    assert.equal(task.title, "原名称");
    assert.equal(task.instruction, "原说明");
    assert.equal(otherGoal.planRevision, 1);
  });

  it("requires reopening a completed goal before adding new work", async () => {
    const f = fixture();
    const goal = await f.service.createGoal({ projectId: "project_1", title: "完成目标", description: "" });
    await f.service.setGoalStatus(goal, "completed");
    await assert.rejects(f.service.addTask(goal, { title: "新步骤", instruction: "执行" }), /先恢复目标/);
    assert.equal(goal.tasks.length, 0);
  });

  it("does not execute work when the queued state cannot be persisted", async () => {
    const f = fixture(undefined, false, 3);
    const goal = await f.service.createGoal({ projectId: "project_1", title: "写文件", description: "" });
    const task = await f.service.addTask(goal, { title: "保存", instruction: "写入" });
    await assert.rejects(f.service.queueTask(goal, task), /disk unavailable/);
    assert.equal(task.status, "planned");
    assert.equal(f.getExecutions(), 0);
  });

  it("does not call the agent when the running state cannot be persisted", async () => {
    const f = fixture(undefined, false, 4);
    const goal = await f.service.createGoal({ projectId: "project_1", title: "写文件", description: "" });
    const task = await f.service.addTask(goal, { title: "保存", instruction: "写入" });
    await f.service.queueTask(goal, task);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.getExecutions(), 0);
    assert.equal(task.status, "failed");
    assert.match(task.error || "", /disk unavailable/);
  });

  it("proposes next steps after the last task and only creates tasks when accepted", async () => {
    let reviewCalls = 0;
    const f = fixture(undefined, false, undefined, async () => {
      reviewCalls++;
      return {
        summary: "已形成第一版报告，尚需核对来源。",
        suggestions: [
          { title: "核对来源", instruction: "逐条核对报告引用", reason: "当前结果尚未核验" },
          { title: "通知相关人员", instruction: "整理并发送摘要", reason: "报告需要交付" }
        ]
      };
    });
    const goal = await f.service.createGoal({ projectId: "project_1", title: "完成报告", description: "" });
    const task = await f.service.addTask(goal, { title: "形成初稿", instruction: "撰写初稿" });
    await f.service.queueTask(goal, task);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(task.status, "completed");
    assert.equal(reviewCalls, 1);
    assert.equal(goal.tasks.length, 1);
    const review = goal.reviews?.[0];
    assert.ok(review);
    assert.equal(review.suggestions.length, 2);
    const accepted = await f.service.decideSuggestion(goal, review.id, review.suggestions[0].id, true);
    assert.equal(accepted.task?.sourceSuggestionId, review.suggestions[0].id);
    assert.equal(goal.tasks.length, 2);
    await f.service.decideSuggestion(goal, review.id, review.suggestions[0].id, true);
    assert.equal(goal.tasks.length, 2);
    await f.service.decideSuggestion(goal, review.id, review.suggestions[1].id, false);
    assert.equal(review.suggestions[1].status, "dismissed");
    assert.equal(goal.tasks.length, 2);
    assert.equal(await f.service.reviewTask(goal, task), review);
    assert.equal(reviewCalls, 1);
  });

  it("waits for existing planned steps before automatically proposing more", async () => {
    let reviewCalls = 0;
    const f = fixture(undefined, false, undefined, async () => { reviewCalls++; return { summary: "完成", suggestions: [] }; });
    const goal = await f.service.createGoal({ projectId: "project_1", title: "两步计划", description: "" });
    const first = await f.service.addTask(goal, { title: "第一步", instruction: "执行第一步" });
    await f.service.addTask(goal, { title: "第二步", instruction: "执行第二步" });
    await f.service.queueTask(goal, first);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reviewCalls, 0);
    assert.equal(goal.reviews?.length || 0, 0);
  });

  it("can retry a review after its first persistence attempt fails", async () => {
    const draft = { summary: "需要核验", suggestions: [{ title: "核验资料", instruction: "逐条检查", reason: "尚未验证" }] };
    const f = fixture(undefined, false, 5, async () => draft);
    const goal = await f.service.createGoal({ projectId: "project_1", title: "验证", description: "" });
    const task = await f.service.addTask(goal, { title: "初稿", instruction: "撰写" });
    await f.service.queueTask(goal, task);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(task.status, "completed");
    assert.equal(goal.reviews?.length || 0, 0);
    const review = await f.service.reviewTask(goal, task);
    assert.equal(review?.suggestions.length, 1);
  });

  it("can retry accepting a suggestion after persistence fails without duplicating the task", async () => {
    const draft = { summary: "需要核验", suggestions: [{ title: "核验资料", instruction: "逐条检查", reason: "尚未验证" }] };
    const f = fixture(undefined, false, 7, async () => draft);
    const goal = await f.service.createGoal({ projectId: "project_1", title: "验证", description: "" });
    const task = await f.service.addTask(goal, { title: "初稿", instruction: "撰写" });
    await f.service.queueTask(goal, task);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const review = goal.reviews?.[0];
    assert.ok(review);
    const suggestion = review.suggestions[0];
    await assert.rejects(f.service.decideSuggestion(goal, review.id, suggestion.id, true), /disk unavailable/);
    assert.equal(suggestion.status, "pending");
    assert.equal(goal.tasks.length, 1);
    await f.service.decideSuggestion(goal, review.id, suggestion.id, true);
    assert.equal(suggestion.status, "accepted");
    assert.equal(goal.tasks.length, 2);
  });
});

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not reached");
}

describe("goal review parsing", () => {
  it("keeps a concise retrospective and deduplicates suggested steps", () => {
    const result = parseGoalReviewResponse('```json\n{"summary":"已完成初稿","suggestions":[{"title":"核验","instruction":"检查来源","reason":"尚未核验"},{"title":"核验","instruction":"重复","reason":"重复"}]}\n```');
    assert.equal(result.summary, "已完成初稿");
    assert.deepEqual(result.suggestions, [{ title: "核验", instruction: "检查来源", reason: "尚未核验" }]);
    assert.throws(() => parseGoalReviewResponse("没有结构化结果"), /JSON/);
  });
});

describe("tool approvals", () => {
  it("tracks approvals for conversations and automations as well as goals", async () => {
    const approvals = new Map();
    let nextId = 0;
    const service = createApprovalService({ approvals, persistStore: async () => undefined, id: () => `approval_${++nextId}`, now: () => "2026-10-03T00:00:00.000Z" });
    const chatApproval = service.request({ conversationId: "conversation_1", toolName: "write_file", riskLevel: "write", args: { path: "report.md" } });
    const automationApproval = service.request({ automationId: "automation_1", toolName: "run_command", riskLevel: "shell", args: { executable: "npm" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = [...approvals.values()];
    assert.equal(pending[0]?.conversationId, "conversation_1");
    assert.equal(pending[1]?.automationId, "automation_1");
    await service.decide(pending[0].id, true);
    await service.decide(pending[1].id, false);
    assert.equal(await chatApproval, true);
    assert.equal(await automationApproval, false);
  });

  it("cancels a pending chat approval when its response stream closes", async () => {
    const approvals = new Map();
    const service = createApprovalService({ approvals, persistStore: async () => undefined, id: () => "approval_1", now: () => "2026-10-03T00:00:00.000Z" });
    const controller = new AbortController();
    const decision = service.request({ conversationId: "conversation_1", toolName: "write_file", riskLevel: "write", args: {}, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    assert.equal(await decision, false);
    assert.equal([...approvals.values()][0]?.status, "cancelled");
  });

  it("shows the complete approved content and rejects previews that cannot be fully shown", async () => {
    const approvals = new Map();
    let nextId = 0;
    const service = createApprovalService({ approvals, persistStore: async () => undefined, id: () => `approval_${++nextId}`, now: () => "2026-10-03T00:00:00.000Z" });
    const content = "a".repeat(5000);
    const decision = service.request({ conversationId: "conversation_1", toolName: "write_file", riskLevel: "write", args: { content } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = [...approvals.values()][0];
    assert.ok(pending.summary.includes(content));
    await service.decide(pending.id, true);
    assert.equal(await decision, true);
    await assert.rejects(
      service.request({ conversationId: "conversation_1", toolName: "write_file", riskLevel: "write", args: { content: "b".repeat(33_000) } }),
      /超过 32000/
    );
    await assert.rejects(
      service.request({ conversationId: "conversation_1", toolName: "run_command", riskLevel: "shell", args: { apiKey: "private" } }),
      /凭据字段/
    );
  });

  it("accepts only one decision when two clients act on the same approval", async () => {
    const approvals = new Map();
    let releasePersist: (() => void) | undefined;
    const persistStore = () => new Promise<void>((resolve) => { releasePersist = resolve; });
    const service = createApprovalService({ approvals, persistStore, id: () => "approval_1", now: () => "2026-10-03T00:00:00.000Z" });
    const decision = service.request({ conversationId: "conversation_1", toolName: "write_file", riskLevel: "write", args: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releasePersist?.();
    const first = service.decide("approval_1", true);
    const second = await service.decide("approval_1", false);
    assert.equal(second, false);
    releasePersist?.();
    assert.equal(await first, true);
    assert.equal(await decision, true);
  });

  it("keeps a sensitive tool blocked until the exact pending approval is accepted", async () => {
    const approvals = new Map();
    let nextId = 0;
    const service = createApprovalService({ approvals, persistStore: async () => undefined, id: () => `approval_${++nextId}`, now: () => "2026-10-03T00:00:00.000Z" });
    let invoked = false;
    const tool: RegisteredTool = {
      definition: { type: "function", function: { name: "write_file", description: "write", parameters: {} } },
      metadata: { riskLevel: "write", permissions: ["workspace:write"] },
      handler: async () => { invoked = true; return "written"; }
    };
    const execution = runRegisteredTool(
      { id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"report.md","content":"hello"}' } },
      tool,
      { workspacePath: process.cwd(), outputPath: process.cwd(), attachments: [] },
      { authorizeTool: (toolName, riskLevel, args) => service.request({ goalId: "goal_1", taskId: "task_1", toolName, riskLevel, args }) }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(invoked, false);
    const pending = [...approvals.values()][0];
    assert.equal(pending.status, "pending");
    await service.decide(pending.id, true);
    const result = await execution;
    assert.equal(invoked, true);
    assert.equal(result.trace.policy.reason, "approved by user");
  });

  it("does not execute a rejected write action", async () => {
    let invoked = false;
    const tool: RegisteredTool = {
      definition: { type: "function", function: { name: "write_file", description: "write", parameters: {} } },
      metadata: { riskLevel: "write", permissions: ["workspace:write"] },
      handler: async () => { invoked = true; return "written"; }
    };
    const result = await runRegisteredTool(
      { id: "call_2", type: "function", function: { name: "write_file", arguments: '{"path":"report.md"}' } },
      tool,
      { workspacePath: process.cwd(), outputPath: process.cwd(), attachments: [] },
      { authorizeTool: async () => false }
    );
    assert.equal(invoked, false);
    assert.equal(result.trace.policy.action, "deny");
  });
});
