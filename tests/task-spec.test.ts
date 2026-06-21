import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateTaskSpec,
  getSkillContextBundles,
  parseReviewVerdict
} from "../server/agent/spec.js";
import { selectPipelineTemplate } from "../server/agent/pipeline.js";
import type { ToolContext } from "../server/tools/types.js";

describe("task spec orchestration", () => {
  it("builds a complex delivery spec with skills and acceptance criteria", () => {
    const spec = generateTaskSpec({
      prompt: "搜索最新行业资料，分析这个 PDF，然后做一个市场分析 PPT",
      context: pdfContext(),
      id: (prefix) => `${prefix}_test`
    });

    assert.equal(spec.id, "spec_test");
    assert.equal(spec.complexity, "complex");
    assert.ok(spec.domains.includes("research"));
    assert.ok(spec.domains.includes("presentation"));
    assert.ok(spec.domains.includes("pdf"));
    assert.ok(spec.requiredSkills.includes("research"));
    assert.ok(spec.requiredSkills.includes("presentation"));
    assert.ok(spec.acceptanceCriteria.some((item) => /source|来源|Research|claims/i.test(item)));
    assert.ok(spec.maxIterations >= 1);
  });

  it("routes pipelines from task specs instead of raw prompt heuristics", () => {
    const spec = generateTaskSpec({
      prompt: "先搜索资料、检查附件，再修复项目里的 bug 并跑测试",
      context: pdfContext(),
      id: (prefix) => `${prefix}_mixed`
    });

    assert.equal(selectPipelineTemplate(spec), "full");
  });

  it("parses structured review verdicts", () => {
    const verdict = parseReviewVerdict(`{
      "passed": false,
      "score": 0.62,
      "failedCriteria": ["Tests were not run"],
      "requiredFixes": ["Run npm test"],
      "risks": ["Coverage unknown"],
      "summary": "Needs verification"
    }`);

    assert.equal(verdict.passed, false);
    assert.equal(verdict.score, 0.62);
    assert.deepEqual(verdict.failedCriteria, ["Tests were not run"]);
    assert.deepEqual(verdict.requiredFixes, ["Run npm test"]);
    assert.equal(verdict.summary, "Needs verification");
  });

  it("loads built-in skill context bundles for required skills", () => {
    const bundles = getSkillContextBundles(["research", "presentation", "missing"]);

    assert.deepEqual(bundles.map((bundle) => bundle.skillId), ["research", "presentation"]);
    assert.ok(bundles.every((bundle) => bundle.acceptance.length > 0));
  });

  it("applies delivery mode budgets to repair iterations and complexity", () => {
    const prompt = "搜索最新行业资料，分析这个 PDF，然后做一个市场分析 PPT";
    const fast = generateTaskSpec({
      prompt,
      context: pdfContext(),
      deliveryMode: "fast",
      id: (prefix) => `${prefix}_fast`
    });
    const standard = generateTaskSpec({
      prompt,
      context: pdfContext(),
      deliveryMode: "standard",
      id: (prefix) => `${prefix}_standard`
    });
    const strict = generateTaskSpec({
      prompt: "帮我看看这个想法怎么样",
      context: emptyContext(),
      deliveryMode: "strict",
      id: (prefix) => `${prefix}_strict`
    });

    assert.equal(fast.maxIterations, 0);
    assert.equal(fast.complexity, "medium");
    assert.equal(standard.maxIterations, 2);
    assert.equal(strict.complexity, "medium");
    assert.equal(strict.maxIterations, 2);
  });
});

function emptyContext(): ToolContext {
  return { workspacePath: process.cwd(), outputPath: process.cwd(), attachments: [] };
}

function pdfContext(): ToolContext {
  return {
    workspacePath: process.cwd(),
    outputPath: process.cwd(),
    attachments: [
      {
        id: "attachment_pdf",
        conversationId: "conversation_1",
        originalName: "report.pdf",
        fileName: "report.pdf",
        mimeType: "application/pdf",
        size: 1024,
        path: "/tmp/report.pdf",
        kind: "file",
        createdAt: new Date().toISOString()
      }
    ]
  };
}
