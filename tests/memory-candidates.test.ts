import assert from "node:assert/strict";
import { it } from "node:test";
import { parseMemoryCandidatesResponse } from "../server/memory/candidates.js";

it("accepts only candidates grounded in exact user text and filters secrets", () => {
  const userText = "我的报告默认使用中文。请不要记住我的 API key 是 abc123。";
  const raw = JSON.stringify({ candidates: [
    { content: "报告默认使用中文", quote: "我的报告默认使用中文", confidence: 0.9 },
    { content: "喜欢蓝色", quote: "我喜欢蓝色", confidence: 0.99 },
    { content: "用户 API key 是 abc123", quote: "我的 API key 是 abc123", confidence: 0.99 },
    { content: "报告默认使用中文", quote: "我的报告默认使用中文", confidence: 0.9 },
    { content: "偏好不确定", quote: "我的报告默认使用中文", confidence: 0.4 }
  ] });
  assert.deepEqual(parseMemoryCandidatesResponse(raw, userText), [{ content: "报告默认使用中文", quote: "我的报告默认使用中文", confidence: 0.9 }]);
  assert.deepEqual(parseMemoryCandidatesResponse("invalid", userText), []);
});
