import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getPipelineDefinition, selectPipelineTemplate } from "../server/agent/pipeline.js";
import type { ToolContext } from "../server/tools/types.js";

describe("team pipeline routing", () => {
  it("routes pure coding tasks to CodeAgent then ReviewAgent", () => {
    assert.equal(selectPipelineTemplate(task("实现登录 bug 修复并运行测试")), "code_review");
    assert.deepEqual(getPipelineDefinition("code_review").stages.map((stage) => stage.agents), [
      ["CodeAgent"],
      ["ReviewAgent"]
    ]);
  });

  it("routes research tasks to ResearchAgent only", () => {
    assert.equal(selectPipelineTemplate(task("搜索最新 API 资料并总结来源")), "research");
  });

  it("routes research plus code tasks through research, code, review", () => {
    assert.equal(selectPipelineTemplate(task("先搜索最新资料，再实现这个项目里的 bug 修复")), "research_code_review");
  });

  it("routes office attachment tasks to OfficeAgent", () => {
    assert.equal(selectPipelineTemplate(task("总结这个文件", pdfContext())), "office");
  });

  it("routes office plus research tasks to the parallel office research template", () => {
    assert.equal(selectPipelineTemplate(task("搜索行业资料并分析这个 xlsx 表格")), "office_research");
    assert.equal(getPipelineDefinition("office_research").stages[0]?.parallel, true);
  });

  it("routes research plus office plus code tasks to the full template", () => {
    assert.equal(selectPipelineTemplate(task("搜索资料、总结这个 PDF，然后修改项目代码", pdfContext())), "full");
  });

  it("keeps ambiguous tasks on the fallback template", () => {
    assert.equal(selectPipelineTemplate(task("帮我看看这个想法怎么样")), "fallback");
  });
});

function task(prompt: string, context: ToolContext = emptyContext()) {
  return { prompt, context };
}

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
