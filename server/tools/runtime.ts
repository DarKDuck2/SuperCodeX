import { evaluateToolPolicy } from "./policy.js";
import type { RegisteredTool, ToolCall, ToolContext, ToolResult, ToolTrace } from "./types.js";

export type ToolRuntimeResult = {
  modelContent: string;
  trace: ToolTrace;
};

const defaultModelContentLimit = 12_000;

export async function runRegisteredTool(
  toolCall: ToolCall,
  tool: RegisteredTool,
  context: ToolContext,
  options: {
    sanitize?: (toolName: string, result: string) => string;
    maxModelContentLength?: number;
    authorizeTool?: ToolContext["authorizeTool"];
    beforeToolExecute?: ToolContext["beforeToolExecute"];
    afterToolExecute?: ToolContext["afterToolExecute"];
    signal?: AbortSignal;
  } = {}
): Promise<ToolRuntimeResult> {
  let args: Record<string, unknown>;
  try {
    args = parseToolArguments(toolCall.function.arguments);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown parse error";
    const result: ToolResult = {
      ok: false,
      summary: `Tool argument error: ${message}`,
      error: message
    };
    const now = new Date().toISOString();
    return {
      modelContent: formatToolResult(result, toolCall.function.name, options.sanitize, options.maxModelContentLength),
      trace: {
        id: toolCall.id,
        toolName: toolCall.function.name,
        args: {},
        policy: { action: "deny", reason: message },
        startedAt: now,
        finishedAt: now,
        result
      }
    };
  }
  let policy = evaluateToolPolicy(tool, args);
  const trace: ToolTrace = {
    id: toolCall.id,
    toolName: toolCall.function.name,
    args,
    policy,
    startedAt: new Date().toISOString()
  };

  if (policy.action === "deny") {
    const result: ToolResult = {
      ok: false,
      summary: policy.reason,
      error: policy.reason,
      metadata: { policyAction: policy.action }
    };
    trace.finishedAt = new Date().toISOString();
    trace.result = result;
    return {
      modelContent: formatToolResult(result, toolCall.function.name, options.sanitize, options.maxModelContentLength),
      trace
    };
  }

  if (options.authorizeTool && ["write", "shell", "external"].includes(tool.metadata.riskLevel)) {
    try {
      const approved = await options.authorizeTool(toolCall.function.name, tool.metadata.riskLevel, args, toolCall.id);
      policy = approved
        ? { action: "allow", reason: "authorized for execution" }
        : { action: "deny", reason: "tool action was not authorized" };
    } catch (error) {
      policy = { action: "deny", reason: error instanceof Error ? error.message : "approval failed" };
    }
    trace.policy = policy;
    if (policy.action === "deny") {
      const result: ToolResult = { ok: false, summary: policy.reason || "approval denied", error: policy.reason };
      trace.finishedAt = new Date().toISOString();
      trace.result = result;
      return { modelContent: formatToolResult(result, toolCall.function.name, options.sanitize, options.maxModelContentLength), trace };
    }
  }

  if (options.signal?.aborted) {
    const reason = "tool action cancelled before execution";
    trace.policy = { action: "deny", reason };
    const result: ToolResult = { ok: false, summary: reason, error: reason };
    trace.finishedAt = new Date().toISOString();
    trace.result = result;
    return { modelContent: formatToolResult(result, toolCall.function.name, options.sanitize, options.maxModelContentLength), trace };
  }

  if (options.beforeToolExecute) {
    await options.beforeToolExecute(toolCall.function.name, tool.metadata.riskLevel, args);
  }
  if (options.signal?.aborted) throw new Error("tool action cancelled before execution");

  let result: ToolResult;
  try {
    const rawResult = await tool.handler(args, context);
    result = normalizeToolResult(rawResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    result = { ok: false, summary: `Tool error: ${message}`, error: message };
  }
  trace.finishedAt = new Date().toISOString();
  trace.result = result;
  // A failed result checkpoint must stop the agent. Returning a normal tool result
  // here could prompt the model to repeat an action whose side effect already happened.
  await options.afterToolExecute?.(toolCall.function.name, tool.metadata.riskLevel, args, result, toolCall.id);
  return {
    modelContent: formatToolResult(result, toolCall.function.name, options.sanitize, options.maxModelContentLength),
    trace
  };
}

function parseToolArguments(value: string) {
  try {
    return JSON.parse(value || "{}") as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid tool arguments JSON: ${error instanceof Error ? error.message : "Unknown parse error"}`);
  }
}

function normalizeToolResult(value: string | ToolResult): ToolResult {
  if (typeof value !== "string") return value;
  return { ok: true, summary: value };
}

function formatToolResult(
  result: ToolResult,
  toolName: string,
  sanitize?: (toolName: string, result: string) => string,
  maxModelContentLength = defaultModelContentLimit
) {
  const parts = [
    result.summary,
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : "",
    result.artifacts?.length
      ? `artifacts:\n${result.artifacts
          .map((artifact) => `- ${artifact.title}${artifact.path ? ` (${artifact.path})` : ""}`)
          .join("\n")}`
      : ""
  ].filter(Boolean);
  const text = parts.join("\n\n") || (result.ok ? "(Tool completed, no output)" : "Tool failed without details");
  const sanitized = sanitize ? sanitize(toolName, text) : text;
  return truncateToolResultForModel(sanitized, toolName, maxModelContentLength);
}

export function truncateToolResultForModel(text: string, toolName: string, limit = defaultModelContentLimit) {
  if (text.length <= limit) return text;
  const marker = `\n[${toolName} output truncated: omitted ${text.length - limit} chars]\n`;
  if (limit <= marker.length + 20) return text.slice(0, limit);
  const available = limit - marker.length;
  const headLength = Math.max(1, Math.floor(available * 0.65));
  const tailLength = Math.max(1, available - headLength);
  const omitted = text.length - headLength - tailLength;
  const adjustedMarker = `\n[${toolName} output truncated: omitted ${omitted} chars]\n`;
  const adjustedAvailable = limit - adjustedMarker.length;
  const adjustedHeadLength = Math.max(1, Math.floor(adjustedAvailable * 0.65));
  const adjustedTailLength = Math.max(1, adjustedAvailable - adjustedHeadLength);
  return `${text.slice(0, adjustedHeadLength).trimEnd()}${adjustedMarker}${text.slice(-adjustedTailLength).trimStart()}`;
}
