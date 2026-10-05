import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

it("resumes a planning-only goal attempt after a real server restart", { timeout: 20_000 }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-goal-recovery-"));
  let heldResponse: ServerResponse | undefined;
  let planningCalls = 0;
  const fakeModel = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { messages?: Array<{ role: string; content?: string }> };
    const isGoalRun = Boolean(body.messages?.some((message) => message.role === "user" && message.content?.includes("当前步骤：规划恢复")));
    if (isGoalRun && ++planningCalls === 1) {
      heldResponse = res;
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "已完成规划恢复步骤" } }] }));
  });
  fakeModel.listen(0, "127.0.0.1");
  await once(fakeModel, "listening");
  const address = fakeModel.address();
  assert.ok(address && typeof address !== "string");
  const env = { ...process.env, PORT: "0", API_BASE_URL: `http://127.0.0.1:${address.port}/v1`, API_KEY: "test-key", API_MODEL: "fake-model" };
  const start = () => spawn(path.join(repoRoot, "node_modules", ".bin", "tsx"), [path.join(repoRoot, "server", "index.ts")], {
    cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"]
  });
  const first = start();
  let second: ReturnType<typeof start> | undefined;
  try {
    const baseUrl = await waitForServer(first);
    const appState = await (await fetch(`${baseUrl}/api/app`)).json() as { projects: Array<{ id: string }> };
    const created = await fetch(`${baseUrl}/api/goals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: appState.projects[0].id, title: "恢复验证", description: "" }) });
    assert.equal(created.status, 201);
    const { goal } = await created.json() as { goal: { id: string; conversationId: string } };
    const taskResponse = await fetch(`${baseUrl}/api/goals/${goal.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "规划恢复", instruction: "生成结果" }) });
    assert.equal(taskResponse.status, 201);
    const { task } = await taskResponse.json() as { task: { id: string } };
    assert.equal((await fetch(`${baseUrl}/api/goals/${goal.id}/tasks/${task.id}/run`, { method: "POST" })).status, 202);
    await waitFor(async () => {
      const current = await getTask(baseUrl, goal.id, task.id);
      return planningCalls === 1 && current?.status === "running" && current.checkpoint?.phase === "planning";
    });
    const firstExit = once(first, "exit");
    first.kill();
    await firstExit;
    heldResponse?.destroy();
    second = start();
    const restartedUrl = await waitForServer(second);
    await waitFor(async () => (await getTask(restartedUrl, goal.id, task.id))?.status === "completed");
    const recovered = await getTask(restartedUrl, goal.id, task.id);
    assert.equal(recovered?.runCount, 2);
    assert.equal(recovered?.checkpoint?.phase, "finished");
    const messages = await (await fetch(`${restartedUrl}/api/conversations/${goal.conversationId}/messages`)).json() as { messages: Array<{ role: string; content: string }> };
    assert.equal(messages.messages.filter((message) => message.role === "user" && message.content.includes("当前步骤：规划恢复")).length, 1);
  } finally {
    await stop(first);
    if (second) await stop(second);
    heldResponse?.destroy();
    fakeModel.close();
    await once(fakeModel, "close");
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function getTask(baseUrl: string, goalId: string, taskId: string) {
  const payload = await (await fetch(`${baseUrl}/api/goals`)).json() as { goals: Array<{ id: string; tasks: Array<{ id: string; status: string; runCount: number; checkpoint?: { phase: string } }> }> };
  return payload.goals.find((goal) => goal.id === goalId)?.tasks.find((task) => task.id === taskId);
}

async function waitFor(condition: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Expected goal state was not reached");
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

async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited.catch(() => undefined);
}
