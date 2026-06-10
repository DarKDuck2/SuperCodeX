import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeCommandInput } from "../server/tools/command.js";
import { ToolRegistry } from "../server/tools/registry.js";
import { runRegisteredTool, truncateToolResultForModel } from "../server/tools/runtime.js";
import { selectToolsForTask } from "../server/tools/selection.js";
import type { RegisteredTool, ToolRiskLevel } from "../server/tools/types.js";

describe("tool orchestration", () => {
  it("normalizes structured command argv", () => {
    const command = normalizeCommandInput({ executable: "npm", args: ["run", "build"] });

    assert.equal(command.executable, "npm");
    assert.deepEqual(command.args, ["run", "build"]);
    assert.equal(command.display, "npm run build");
    assert.equal(command.source, "argv");
  });

  it("keeps legacy command compatibility for simple commands", () => {
    const command = normalizeCommandInput({ command: "npm test" });

    assert.equal(command.executable, "npm");
    assert.deepEqual(command.args, ["test"]);
    assert.equal(command.source, "legacy");
  });

  it("rejects legacy commands that require shell operators", () => {
    assert.throws(
      () => normalizeCommandInput({ command: "npm test && npm run build" }),
      /Shell operators are not supported/
    );
  });

  it("keeps tool metadata in the registry", () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: {} }
        }
      },
      { riskLevel: "read", permissions: ["workspace:read"] },
      async () => "ok"
    );

    assert.deepEqual(registry.names(), ["read_file"]);
    assert.equal(registry.get("read_file")?.metadata.riskLevel, "read");
    assert.equal(registry.definitions()[0]?.function.name, "read_file");
  });

  it("denies blocked shell commands before invoking the handler", async () => {
    const registry = new ToolRegistry();
    let invoked = false;
    registry.register(
      {
        type: "function",
        function: {
          name: "run_command",
          description: "Run a command",
          parameters: { type: "object", properties: {} }
        }
      },
      { riskLevel: "shell", permissions: ["shell:run"] },
      async () => {
        invoked = true;
        return "should not run";
      }
    );

    const tool = registry.get("run_command");
    assert.ok(tool);
    const result = await runRegisteredTool(
      {
        id: "call_1",
        type: "function",
        function: { name: "run_command", arguments: JSON.stringify({ command: "rm -rf dist" }) }
      },
      tool,
      { workspacePath: process.cwd(), outputPath: process.cwd(), attachments: [] }
    );

    assert.equal(invoked, false);
    assert.equal(result.trace.policy.action, "deny");
    assert.match(result.modelContent, /Command blocked/);
  });

  it("auto-allows routine shell tools without user approval", async () => {
    let invoked = false;
    const tool = {
      ...testTool("run_command", "shell"),
      metadata: { riskLevel: "shell" as const, permissions: ["shell:run" as const] },
      handler: async () => {
        invoked = true;
        return "ran";
      }
    };
    const toolCall = {
      id: "call_approval",
      type: "function" as const,
      function: { name: "run_command", arguments: JSON.stringify({ executable: "node", args: ["--version"] }) }
    };
    const context = { workspacePath: process.cwd(), outputPath: process.cwd(), attachments: [] };

    const approved = await runRegisteredTool(toolCall, tool, context);
    assert.equal(invoked, true);
    assert.equal(approved.trace.policy.action, "allow");
    assert.match(approved.modelContent, /ran/);
  });

  it("truncates large tool results while preserving head and tail context", () => {
    const text = `${"a".repeat(80)} middle ${"z".repeat(80)}`;
    const truncated = truncateToolResultForModel(text, "search_files", 100);

    assert.ok(truncated.length < text.length);
    assert.match(truncated, /output truncated/);
    assert.match(truncated, /^a+/);
    assert.match(truncated, /z+$/);
  });

  it("selects task-relevant tools conservatively", () => {
    const tools = [
      testTool("read_file", "read"),
      testTool("run_command", "shell"),
      testTool("search_web", "network"),
      testTool("webbridge_command", "external")
    ];

    const fileTask = selectToolsForTask(tools, {
      prompt: "读取 README 并总结",
      context: { workspacePath: process.cwd(), outputPath: process.cwd(), attachments: [] }
    }).map((tool) => tool.definition.function.name);
    assert.deepEqual(fileTask, ["read_file"]);

    const webTask = selectToolsForTask(tools, {
      prompt: "搜索最新新闻",
      context: { workspacePath: process.cwd(), outputPath: process.cwd(), attachments: [] }
    }).map((tool) => tool.definition.function.name);
    assert.deepEqual(webTask, ["read_file", "search_web"]);

    const commandTask = selectToolsForTask(tools, {
      prompt: "运行 npm test",
      context: { workspacePath: process.cwd(), outputPath: process.cwd(), attachments: [] }
    }).map((tool) => tool.definition.function.name);
    assert.deepEqual(commandTask, ["read_file", "run_command"]);
  });

  it("expands tool selection from active skill categories", () => {
    const tools = [
      testTool("read_file", "read"),
      testTool("run_command", "shell"),
      testTool("search_web", "network"),
      testTool("discover_or_load_skill", "read")
    ];

    const excelTask = selectToolsForTask(tools, {
      prompt: "整理这份数据",
      context: { workspacePath: process.cwd(), outputPath: process.cwd(), attachments: [] },
      activeSkillIds: ["excel"],
      activeSkillCategories: ["spreadsheet", "office"],
      activeSkillKeywords: ["xlsx", "csv", "公式"]
    }).map((tool) => tool.definition.function.name);

    assert.deepEqual(excelTask, ["read_file", "run_command", "discover_or_load_skill"]);
  });
});

function testTool(name: string, riskLevel: ToolRiskLevel): RegisteredTool {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: name,
        parameters: { type: "object", properties: {} }
      }
    },
    metadata: { riskLevel, permissions: [] },
    handler: async () => "ok"
  };
}
