import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryFact } from "../server/domain/types.js";
import { selectRelevantMemories } from "../server/memory/retrieval.js";

function memory(id: string, content: string, options: Partial<MemoryFact> = {}): MemoryFact {
  return { id, content, scope: "personal", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...options };
}

test("personal memory uses task relevance while always and private modes control context", () => {
  const memories = [
    memory("language", "报告使用中文并附来源"),
    memory("unrelated", "我喜欢周末爬山"),
    memory("always", "称呼我为小王", { useMode: "always" }),
    memory("private", "我的住址是上海某街道", { useMode: "private" })
  ];
  assert.deepEqual(selectRelevantMemories(memories, { query: "请写一份中文报告" }).map((item) => item.id), ["always", "language"]);
  assert.deepEqual(selectRelevantMemories(memories, { query: "天气怎么样" }).map((item) => item.id), ["always"]);
});

test("goal memories stay within their goal and respect private mode", () => {
  const memories = [
    memory("goal-one", "交付时附上测试记录", { scope: "goal", goalId: "goal-1" }),
    memory("goal-two", "只用于第二个目标", { scope: "goal", goalId: "goal-2", useMode: "always" }),
    memory("private-goal", "内部预算", { scope: "goal", goalId: "goal-1", useMode: "private" })
  ];
  assert.deepEqual(selectRelevantMemories(memories, { query: "下一步", goalId: "goal-1" }).map((item) => item.id), ["goal-one"]);
  assert.deepEqual(selectRelevantMemories(memories, { query: "下一步" }).map((item) => item.id), []);
  assert.deepEqual(selectRelevantMemories(memories.slice(1), { query: "下一步", goalId: "goal-1" }).map((item) => item.id), []);
});

test("memory selection enforces context budget and deletion removes future use", () => {
  const memories = [memory("first", "请使用中文", { useMode: "always" }), memory("second", "a".repeat(120), { useMode: "always" })];
  assert.deepEqual(selectRelevantMemories(memories, { query: "任意任务", maxChars: 100 }).map((item) => item.id), ["first"]);
  assert.deepEqual(selectRelevantMemories(memories.filter((item) => item.id !== "first"), { query: "中文任务", maxChars: 100 }).map((item) => item.id), []);
});
