import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeNextRunAt, normalizeScheduleText, parseAutomationInput } from "../server/automation/schedule.js";

describe("automation schedule parsing", () => {
  it("parses fixed intervals", () => {
    assert.equal(normalizeScheduleText("每2h"), "每2小时");
    assert.equal(normalizeScheduleText("每 3 小时"), "每3小时");
  });

  it("parses common daily Chinese time expressions", () => {
    assert.equal(normalizeScheduleText("每天早上9点"), "每天 09:00");
    assert.equal(normalizeScheduleText("下午 3点30分"), "每天 15:30");
    assert.equal(normalizeScheduleText("下班前"), "每天 17:30");
  });

  it("extracts automation prompt and title from natural language", () => {
    const parsed = parseAutomationInput({ instruction: "每天早上9点返回新闻" });
    assert.equal(parsed.schedule, "每天 09:00");
    assert.equal(parsed.prompt, "返回新闻");
    assert.equal(parsed.title, "返回新闻");
  });

  it("computes the next daily run", () => {
    const next = computeNextRunAt("每天 09:00", new Date("2026-06-09T08:00:00+08:00"));
    assert.equal(next, new Date("2026-06-09T09:00:00+08:00").toISOString());
  });
});
