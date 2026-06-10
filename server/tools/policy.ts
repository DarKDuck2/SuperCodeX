import { normalizeCommandInput } from "./command.js";
import type { RegisteredTool, ToolPolicyDecision } from "./types.js";

export function evaluateToolPolicy(
  tool: RegisteredTool,
  args: Record<string, unknown>
): ToolPolicyDecision {
  if (tool.metadata.riskLevel === "destructive") {
    return { action: "deny", reason: "destructive tools are disabled by policy" };
  }

  if (tool.definition.function.name === "run_command") {
    try {
      normalizeCommandInput(args);
    } catch (error) {
      return {
        action: "deny",
        reason: error instanceof Error ? error.message : "Command blocked by SuperCodex automatic safety policy"
      };
    }
  }

  return { action: "allow" };
}
