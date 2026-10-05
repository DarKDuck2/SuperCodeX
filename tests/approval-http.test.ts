import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

it("verifies approval flows and goal review through the HTTP API", { timeout: 20_000 }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-approval-http-"));
  const memoryContextRequests: Array<Array<{ role: string; content?: string }>> = [];
  const goalToolNames = new Set<string>();
  let artifactIdForModel = "";
  const fakeModel = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { tools?: unknown[]; messages?: Array<{ role: string; content?: string }> };
    const prompt = body.messages?.findLast((message) => message.role === "user")?.content || "";
    const fileName = prompt.includes("定时任务") ? "automation.txt" : prompt.includes("取消") ? "cancelled.txt" : prompt.includes("拒绝") ? "rejected.txt" : "approved.txt";
    const reviewingGoal = body.messages?.some((item) => item.role === "system" && item.content?.includes("长期目标复盘助手"));
    const extractingMemory = body.messages?.some((item) => item.role === "system" && item.content?.includes("Extract at most 3 durable facts"));
    if (prompt.includes("检查记忆上下文") && !extractingMemory) memoryContextRequests.push(body.messages || []);
    const executingGoal = body.messages?.some((item) => item.role === "user" && item.content?.includes("长期目标："));
    const updatingGoalArtifact = executingGoal && prompt.includes("当前步骤：更新目标文稿");
    const writingGoalFile = executingGoal && prompt.includes("当前步骤：输出目标文件");
    const currentTaskMessages = body.messages?.slice((body.messages?.findLastIndex((item) => item.role === "user") ?? -1) + 1) || [];
    if (executingGoal && body.tools?.length) {
      for (const tool of body.tools as Array<{ function?: { name?: string } }>) if (tool.function?.name) goalToolNames.add(tool.function.name);
    }
    const message = extractingMemory
      ? { content: JSON.stringify({ candidates: [{ content: "用户的报告默认使用中文，并附可核对的来源。", quote: "我的报告默认使用中文，并且每次都附上可核对的来源", confidence: 0.94 }] }) }
      : reviewingGoal
      ? { content: JSON.stringify({ summary: "初稿已完成，需要核对来源", suggestions: [{ title: "核对来源", instruction: "核对报告中的每条来源", reason: "初稿尚未验证" }] }) }
      : !body.tools?.length
      ? { content: "工具审批验证" }
      : writingGoalFile
        ? currentTaskMessages.some((item) => item.role === "tool")
          ? { content: "目标文件已生成" }
          : { content: "", tool_calls: [{ id: "call_goal_file", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "goal-deliverable.md", content: "目标交付内容" }) } }] }
      : updatingGoalArtifact
        ? body.messages?.some((item) => item.role === "tool")
          ? { content: "目标文稿已更新" }
          : { content: "", tool_calls: [{ id: "call_goal_artifact", type: "function", function: { name: "save_goal_artifact", arguments: JSON.stringify({ artifactId: artifactIdForModel, expectedRevision: 2, title: "持续报告", content: "已核对初稿，并补充结论" }) } }] }
      : prompt.includes("检查记忆上下文")
        ? { content: "记忆上下文已检查" }
      : prompt.includes("我的报告默认使用中文")
        ? { content: "已了解你的报告偏好" }
      : executingGoal
        ? { content: "已完成初稿" }
      : body.messages?.some((item) => item.role === "tool")
        ? { content: "工具调用已处理" }
        : { content: "", tool_calls: [{ id: "call_write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: fileName, content: "verification content" }) } }] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  fakeModel.listen(0, "127.0.0.1");
  await once(fakeModel, "listening");
  const modelAddress = fakeModel.address();
  assert.ok(modelAddress && typeof modelAddress !== "string");
  const child = spawn(path.join(repoRoot, "node_modules", ".bin", "tsx"), [path.join(repoRoot, "server", "index.ts")], {
    cwd: workspace,
    env: { ...process.env, PORT: "0", API_BASE_URL: `http://127.0.0.1:${modelAddress.port}/v1`, API_KEY: "test-key", API_MODEL: "fake-model" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let restarted: ReturnType<typeof spawn> | undefined;
  try {
    const baseUrl = await waitForServer(child);
    let approvedApprovalId = "";
    for (const [prompt, approved, fileName] of [
      ["请写入批准文件", true, "approved.txt"],
      ["请写入拒绝文件", false, "rejected.txt"]
    ] as const) {
      const created = await fetch(`${baseUrl}/api/conversations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "审批验证" }) });
      assert.equal(created.status, 201);
      const conversation = await created.json() as { id: string };
      const stream = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: prompt, stream: true })
      });
      assert.equal(stream.status, 200);
      const completed = stream.text();
      const pending = await waitForApproval(baseUrl, conversation.id);
      if (approved) approvedApprovalId = pending.id;
      assert.equal(pending.toolName, "write_file");
      await assert.rejects(fs.stat(path.join(workspace, "supercodex-files", fileName)), { code: "ENOENT" });
      const decided = await fetch(`${baseUrl}/api/approvals/${pending.id}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved })
      });
      assert.equal(decided.status, 200);
      const events = await completed;
      assert.match(events, /\[DONE\]/);
      if (approved) assert.equal(await fs.readFile(path.join(workspace, "supercodex-files", fileName), "utf-8"), "verification content");
      else await assert.rejects(fs.stat(path.join(workspace, "supercodex-files", fileName)), { code: "ENOENT" });
    }
    const created = await fetch(`${baseUrl}/api/conversations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "断开审批验证" }) });
    const conversation = await created.json() as { id: string };
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "请写入取消文件", stream: true }), signal: controller.signal
    });
    const completed = stream.text();
    const pending = await waitForApproval(baseUrl, conversation.id);
    controller.abort();
    await assert.rejects(completed, /abort/i);
    await waitForApprovalStatus(baseUrl, pending.id, "cancelled");
    await assert.rejects(fs.stat(path.join(workspace, "supercodex-files", "cancelled.txt")), { code: "ENOENT" });

    const automationResponse = await fetch(`${baseUrl}/api/automations`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "审批定时任务", schedule: "每天 23:59", prompt: "请写入自动化文件" })
    });
    assert.equal(automationResponse.status, 201);
    const { automation } = await automationResponse.json() as { automation: { id: string } };
    const started = await fetch(`${baseUrl}/api/automations/${automation.id}/run`, { method: "POST" });
    assert.equal(started.status, 202);
    const automationPending = await waitForAutomationApproval(baseUrl, automation.id);
    await assert.rejects(fs.stat(path.join(workspace, "supercodex-files", "automation.txt")), { code: "ENOENT" });
    const automationDecision = await fetch(`${baseUrl}/api/approvals/${automationPending.id}/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: true })
    });
    assert.equal(automationDecision.status, 200);
    await waitForAutomationStatus(baseUrl, automation.id, "success");
    assert.equal(await fs.readFile(path.join(workspace, "supercodex-files", "automation.txt"), "utf-8"), "verification content");

    const appResponse = await fetch(`${baseUrl}/api/app`);
    const appState = await appResponse.json() as { projects: Array<{ id: string }> };
    const goalResponse = await fetch(`${baseUrl}/api/goals`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: appState.projects[0].id, title: "报告目标", description: "形成可信报告" })
    });
    assert.equal(goalResponse.status, 201);
    const { goal } = await goalResponse.json() as { goal: { id: string } };
    const taskResponse = await fetch(`${baseUrl}/api/goals/${goal.id}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "形成初稿", instruction: "完成无工具步骤" })
    });
    assert.equal(taskResponse.status, 201);
    const { task } = await taskResponse.json() as { task: { id: string } };
    const queued = await fetch(`${baseUrl}/api/goals/${goal.id}/tasks/${task.id}/run`, { method: "POST" });
    assert.equal(queued.status, 202);
    const reviewed = await waitForGoalReview(baseUrl, goal.id);
    assert.ok(goalToolNames.has("read_goal_artifact"));
    assert.ok(goalToolNames.has("save_goal_artifact"));
    assert.equal(reviewed.tasks.length, 1);
    assert.equal(reviewed.reviews?.[0]?.suggestions[0]?.status, "pending");
    const review = reviewed.reviews![0];
    const manualReview = await fetch(`${baseUrl}/api/goals/${goal.id}/reviews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(manualReview.status, 200);
    const manualResult = await manualReview.json() as { review: { id: string } };
    assert.equal(manualResult.review.id, review.id);
    const acceptResponse = await fetch(`${baseUrl}/api/goals/${goal.id}/reviews/${review.id}/suggestions/${review.suggestions[0].id}/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accept: true })
    });
    assert.equal(acceptResponse.status, 200);
    const accepted = await acceptResponse.json() as { goal: { tasks: Array<{ sourceSuggestionId?: string }> } };
    assert.equal(accepted.goal.tasks.length, 2);
    assert.equal(accepted.goal.tasks[1].sourceSuggestionId, review.suggestions[0].id);
    const extraTaskResponse = await fetch(`${baseUrl}/api/goals/${goal.id}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "整理交付", instruction: "检查报告格式" })
    });
    assert.equal(extraTaskResponse.status, 201);
    const extraTask = await extraTaskResponse.json() as { task: { id: string }; goal: { planRevision: number } };
    const suggestionTaskId = (await (await fetch(`${baseUrl}/api/goals`)).json() as { goals: Array<{ id: string; tasks: Array<{ id: string; sourceSuggestionId?: string }> }> }).goals
      .find((item) => item.id === goal.id)!.tasks.find((item) => item.sourceSuggestionId === review.suggestions[0].id)!.id;
    const reorderedResponse = await fetch(`${baseUrl}/api/goals/${goal.id}/task-order`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: [extraTask.task.id, suggestionTaskId], expectedPlanRevision: extraTask.goal.planRevision })
    });
    assert.equal(reorderedResponse.status, 200);
    const reordered = await reorderedResponse.json() as { goal: { tasks: Array<{ id: string }>; planRevision: number } };
    assert.deepEqual(reordered.goal.tasks.map((item) => item.id), [task.id, extraTask.task.id, suggestionTaskId]);
    assert.equal((await fetch(`${baseUrl}/api/goals/${goal.id}/task-order`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: [suggestionTaskId, extraTask.task.id], expectedPlanRevision: extraTask.goal.planRevision })
    })).status, 409);

    const artifactCreateResponse = await fetch(`${baseUrl}/api/goals/${goal.id}/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "持续报告", content: "初稿" })
    });
    assert.equal(artifactCreateResponse.status, 201);
    const artifactCreated = await artifactCreateResponse.json() as { artifact: { id: string; revision: number } };
    artifactIdForModel = artifactCreated.artifact.id;
    const artifactUpdateResponse = await fetch(`${baseUrl}/api/goals/${goal.id}/artifacts/${artifactCreated.artifact.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "持续报告", content: "已核对初稿", expectedRevision: 1 })
    });
    assert.equal(artifactUpdateResponse.status, 200);
    assert.equal((await artifactUpdateResponse.json() as { artifact: { revision: number } }).artifact.revision, 2);
    assert.equal((await fetch(`${baseUrl}/api/goals/${goal.id}/artifacts/${artifactCreated.artifact.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "持续报告", content: "过期写入", expectedRevision: 1 })
    })).status, 409);

    const artifactTaskResponse = await fetch(`${baseUrl}/api/goals/${goal.id}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "更新目标文稿", instruction: "补充已核对的结论" })
    });
    assert.equal(artifactTaskResponse.status, 201);
    const artifactTask = await artifactTaskResponse.json() as { task: { id: string } };
    assert.equal((await fetch(`${baseUrl}/api/goals/${goal.id}/tasks/${artifactTask.task.id}/run`, { method: "POST" })).status, 202);
    const artifactApproval = await waitForGoalApproval(baseUrl, goal.id, artifactTask.task.id);
    assert.equal(artifactApproval.toolName, "save_goal_artifact");
    assert.equal((await fetch(`${baseUrl}/api/approvals/${artifactApproval.id}/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: true })
    })).status, 200);
    await waitForGoalTaskStatus(baseUrl, goal.id, artifactTask.task.id, "completed");
    const afterAgentArtifact = await (await fetch(`${baseUrl}/api/goals`)).json() as { goals: Array<{ id: string; artifacts?: Array<{ id: string; content: string; revision: number; updatedBy: string }> }> };
    assert.ok(afterAgentArtifact.goals.find((item) => item.id === goal.id)?.artifacts?.some((item) => item.id === artifactCreated.artifact.id && item.content === "已核对初稿，并补充结论" && item.revision === 3 && item.updatedBy === "agent"));
    assert.equal((await fetch(`${baseUrl}/api/goals/${goal.id}/artifacts/${artifactCreated.artifact.id}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 2, sourceRevision: 1 })
    })).status, 409);
    const artifactRestoreResponse = await fetch(`${baseUrl}/api/goals/${goal.id}/artifacts/${artifactCreated.artifact.id}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 3, sourceRevision: 2 })
    });
    assert.equal(artifactRestoreResponse.status, 200);
    const artifactRestored = await artifactRestoreResponse.json() as { artifact: { revision: number; content: string; restoredFromRevision?: number; history?: Array<{ revision: number; updatedBy: string }> } };
    assert.equal(artifactRestored.artifact.revision, 4);
    assert.equal(artifactRestored.artifact.content, "已核对初稿");
    assert.equal(artifactRestored.artifact.restoredFromRevision, 2);
    assert.deepEqual(artifactRestored.artifact.history?.map((version) => [version.revision, version.updatedBy]), [[3, "agent"], [2, "user"], [1, "user"]]);

    const fileTaskResponse = await fetch(`${baseUrl}/api/goals/${goal.id}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "输出目标文件", instruction: "生成 Markdown 交付文件" })
    });
    assert.equal(fileTaskResponse.status, 201);
    const fileTask = await fileTaskResponse.json() as { task: { id: string } };
    assert.equal((await fetch(`${baseUrl}/api/goals/${goal.id}/tasks/${fileTask.task.id}/run`, { method: "POST" })).status, 202);
    const fileApproval = await waitForGoalApproval(baseUrl, goal.id, fileTask.task.id);
    assert.equal(fileApproval.toolName, "write_file");
    assert.equal((await fetch(`${baseUrl}/api/approvals/${fileApproval.id}/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: true })
    })).status, 200);
    await waitForGoalTaskStatus(baseUrl, goal.id, fileTask.task.id, "completed");
    const fileGoal = (await (await fetch(`${baseUrl}/api/goals`)).json() as { goals: Array<{ id: string; files?: Array<{ id: string; path: string; taskId: string; revision?: number; snapshotSha256?: string }> }> }).goals.find((item) => item.id === goal.id);
    const goalFile = fileGoal?.files?.find((file) => file.path === "supercodex-files/goal-deliverable.md" && file.taskId === fileTask.task.id);
    assert.ok(goalFile);
    assert.equal(goalFile.revision, 1);
    assert.equal(goalFile.snapshotSha256?.length, 64);
    const fileDownload = await fetch(`${baseUrl}/api/goals/${goal.id}/files/${goalFile.id}/content`);
    assert.equal(fileDownload.status, 200);
    assert.match(fileDownload.headers.get("content-disposition") || "", /attachment/);
    assert.equal(await fileDownload.text(), "目标交付内容");
    assert.equal((await fetch(`${baseUrl}/api/goals/${goal.id}/files/unknown/content`)).status, 404);
    await fs.writeFile(path.join(workspace, "supercodex-files", "goal-deliverable.md"), "后来被修改的工作区文件");
    assert.equal(await (await fetch(`${baseUrl}/api/goals/${goal.id}/files/${goalFile.id}/content`)).text(), "目标交付内容");

    const memoryConversationResponse = await fetch(`${baseUrl}/api/conversations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "记忆验证" }) });
    const memoryConversation = await memoryConversationResponse.json() as { id: string };
    const userText = "我的报告默认使用中文，并且每次都附上可核对的来源。";
    const memoryMessage = await fetch(`${baseUrl}/api/conversations/${memoryConversation.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: userText })
    });
    assert.equal(memoryMessage.status, 201);
    const candidate = await waitForMemoryCandidate(baseUrl);
    assert.equal(candidate.sourceQuote, userText.slice(0, -1));
    const acceptedMemoryResponse = await fetch(`${baseUrl}/api/memory-candidates/${candidate.id}/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accept: true, content: "报告使用中文并附来源" })
    });
    assert.equal(acceptedMemoryResponse.status, 200);
    const acceptedMemory = await acceptedMemoryResponse.json() as { memory: { id: string; content: string; sourceMessageId: string; sourceQuote: string } };
    assert.equal(acceptedMemory.memory.content, "报告使用中文并附来源");
    assert.equal(acceptedMemory.memory.sourceQuote, candidate.sourceQuote);
    assert.ok(acceptedMemory.memory.sourceMessageId);
    assert.equal((await fetch(`${baseUrl}/api/memories/${acceptedMemory.memory.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ useMode: "invalid" })
    })).status, 400);
    const privateMemoryResponse = await fetch(`${baseUrl}/api/memories/${acceptedMemory.memory.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ useMode: "private" })
    });
    assert.equal(privateMemoryResponse.status, 200);
    assert.equal((await privateMemoryResponse.json() as { memory: { useMode: string } }).memory.useMode, "private");
    const contextConversation = await (await fetch(`${baseUrl}/api/conversations`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "记忆上下文检查" })
    })).json() as { id: string };
    const checkContext = () => fetch(`${baseUrl}/api/conversations/${contextConversation.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "检查记忆上下文" })
    });
    assert.equal((await checkContext()).status, 201);
    assert.ok(!memoryContextRequests.at(-1)?.some((message) => message.role === "system" && message.content?.includes("报告使用中文并附来源")));
    assert.equal((await fetch(`${baseUrl}/api/memories/${acceptedMemory.memory.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ useMode: "always" })
    })).status, 200);
    assert.equal((await checkContext()).status, 201);
    assert.ok(memoryContextRequests.at(-1)?.some((message) => message.role === "system" && message.content?.includes("报告使用中文并附来源")));
    assert.equal((await fetch(`${baseUrl}/api/memories/${acceptedMemory.memory.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ useMode: "private" })
    })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/memory-candidates/${candidate.id}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accept: true }) })).status, 409);

    const attentionBefore = await (await fetch(`${baseUrl}/api/attention`)).json() as { items: Array<{ id: string; goalId?: string; read: boolean }> };
    const goalAttention = attentionBefore.items.find((item) => item.goalId === goal.id);
    assert.ok(goalAttention);
    const attentionModeResponse = await fetch(`${baseUrl}/api/attention/preferences`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "all" }) });
    assert.equal(attentionModeResponse.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/attention/${encodeURIComponent(goalAttention.id)}/read`, { method: "POST" })).status, 200);

    assert.ok(await fs.stat(path.join(workspace, ".supercodex", "state.sqlite")));
    await assert.rejects(fs.stat(path.join(workspace, ".supercodex", "state.json")), { code: "ENOENT" });
    const firstExit = once(child, "exit");
    child.kill();
    await firstExit;
    restarted = spawn(path.join(repoRoot, "node_modules", ".bin", "tsx"), [path.join(repoRoot, "server", "index.ts")], {
      cwd: workspace,
      env: { ...process.env, PORT: "0", API_BASE_URL: `http://127.0.0.1:${modelAddress.port}/v1`, API_KEY: "test-key", API_MODEL: "fake-model" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const restartedUrl = await waitForServer(restarted);
    const restoredGoals = await (await fetch(`${restartedUrl}/api/goals`)).json() as { goals: Array<{ id: string; tasks: Array<{ id: string }>; reviews?: Array<{ id: string }>; artifacts?: Array<{ id: string; content: string; revision: number; restoredFromRevision?: number; history?: Array<{ revision: number }> }> }> };
    const restored = restoredGoals.goals.find((item) => item.id === goal.id);
    assert.deepEqual(restored?.tasks.map((item) => item.id), [task.id, extraTask.task.id, suggestionTaskId, artifactTask.task.id, fileTask.task.id]);
    assert.ok(restored?.reviews?.some((item) => item.id === review.id));
    assert.ok(restored?.artifacts?.some((item) => item.id === artifactCreated.artifact.id && item.content === "已核对初稿" && item.revision === 4 && item.restoredFromRevision === 2 && item.history?.length === 3));
    const persistedFiles = (await (await fetch(`${restartedUrl}/api/goals`)).json() as { goals: Array<{ id: string; files?: Array<{ id: string; path: string }> }> }).goals.find((item) => item.id === goal.id)?.files;
    assert.ok(persistedFiles?.some((file) => file.id === goalFile.id && file.path === "supercodex-files/goal-deliverable.md"));
    assert.equal(await (await fetch(`${restartedUrl}/api/goals/${goal.id}/files/${goalFile.id}/content`)).text(), "目标交付内容");
    const restoredApprovals = await (await fetch(`${restartedUrl}/api/approvals`)).json() as { approvals: Array<{ id: string; status: string }> };
    assert.ok(restoredApprovals.approvals.some((item) => item.id === approvedApprovalId && item.status === "approved"));
    const restoredAttention = await (await fetch(`${restartedUrl}/api/attention`)).json() as { mode: string; items: Array<{ id: string; read: boolean }> };
    assert.equal(restoredAttention.mode, "all");
    assert.equal(restoredAttention.items.find((item) => item.id === goalAttention.id)?.read, true);
    const restoredMemories = await (await fetch(`${restartedUrl}/api/memories`)).json() as { memories: Array<{ id: string; sourceQuote?: string; useMode?: string }> };
    assert.ok(restoredMemories.memories.some((item) => item.id === acceptedMemory.memory.id && item.sourceQuote === candidate.sourceQuote && item.useMode === "private"));
    assert.equal((await fetch(`${restartedUrl}/api/memories/${acceptedMemory.memory.id}`, { method: "DELETE" })).status, 204);
    const forgottenMemories = await (await fetch(`${restartedUrl}/api/memories`)).json() as { memories: Array<{ id: string }> };
    assert.ok(!forgottenMemories.memories.some((item) => item.id === acceptedMemory.memory.id));
    const forgottenState = await (await fetch(`${restartedUrl}/api/app`)).json() as { memoryCandidates: Array<{ id: string }> };
    assert.ok(!forgottenState.memoryCandidates.some((item) => item.id === candidate.id));
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited.catch(() => undefined);
    }
    if (restarted && restarted.exitCode === null) {
      const exited = once(restarted, "exit");
      restarted.kill();
      await exited.catch(() => undefined);
    }
    fakeModel.close();
    await once(fakeModel, "close");
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function waitForMemoryCandidate(baseUrl: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${baseUrl}/api/memory-candidates`);
    const payload = await response.json() as { candidates: Array<{ id: string; sourceQuote: string }> };
    if (payload.candidates[0]) return payload.candidates[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Memory candidate was not created");
}

function waitForServer(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/SuperCodex API listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited with ${code}: ${output}`)); });
  });
}

async function waitForApproval(baseUrl: string, conversationId: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${baseUrl}/api/approvals`);
    const payload = await response.json() as { approvals: Array<{ id: string; conversationId?: string; toolName: string; status: string }> };
    const pending = payload.approvals.find((item) => item.conversationId === conversationId && item.status === "pending");
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Approval was not created");
}

async function waitForApprovalStatus(baseUrl: string, approvalId: string, status: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${baseUrl}/api/approvals`);
    const payload = await response.json() as { approvals: Array<{ id: string; status: string }> };
    if (payload.approvals.some((item) => item.id === approvalId && item.status === status)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Approval did not become ${status}`);
}

async function waitForAutomationApproval(baseUrl: string, automationId: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${baseUrl}/api/approvals`);
    const payload = await response.json() as { approvals: Array<{ id: string; automationId?: string; status: string }> };
    const pending = payload.approvals.find((item) => item.automationId === automationId && item.status === "pending");
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Automation approval was not created");
}

async function waitForGoalApproval(baseUrl: string, goalId: string, taskId: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${baseUrl}/api/approvals`);
    const payload = await response.json() as { approvals: Array<{ id: string; goalId?: string; taskId?: string; toolName: string; status: string }> };
    const pending = payload.approvals.find((item) => item.goalId === goalId && item.taskId === taskId && item.status === "pending");
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Goal artifact approval was not created");
}

async function waitForGoalTaskStatus(baseUrl: string, goalId: string, taskId: string, status: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${baseUrl}/api/goals`);
    const payload = await response.json() as { goals: Array<{ id: string; tasks: Array<{ id: string; status: string }> }> };
    if (payload.goals.find((item) => item.id === goalId)?.tasks.some((item) => item.id === taskId && item.status === status)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Goal task did not become ${status}`);
}

async function waitForAutomationStatus(baseUrl: string, automationId: string, status: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${baseUrl}/api/automations`);
    const payload = await response.json() as { automations: Array<{ id: string; lastStatus: string }> };
    if (payload.automations.some((item) => item.id === automationId && item.lastStatus === status)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Automation did not become ${status}`);
}

async function waitForGoalReview(baseUrl: string, goalId: string) {
  type GoalWithReview = {
    id: string;
    tasks: Array<{ id: string; status: string }>;
    reviews?: Array<{ id: string; suggestions: Array<{ id: string; status: string }> }>;
  };
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${baseUrl}/api/goals`);
    const payload = await response.json() as { goals: GoalWithReview[] };
    const goal = payload.goals.find((item) => item.id === goalId);
    if (goal?.tasks[0]?.status === "completed" && goal.reviews?.length) return goal;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Goal review was not created");
}
