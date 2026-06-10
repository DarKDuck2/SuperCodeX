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
  } = {}
): Promise<ToolRuntimeResult> {
  const args = parseToolArguments(toolCall.function.arguments);
  const policy = evaluateToolPolicy(tool, args);
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

  try {
    const rawResult = await tool.handler(args, context);
    const result = normalizeToolResult(rawResult);
    trace.finishedAt = new Date().toISOString();
    trace.result = result;
    return {
      modelContent: formatToolResult(result, toolCall.function.name, options.sanitize, options.maxModelContentLength),
      trace
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const result: ToolResult = { ok: false, summary: `Tool error: ${message}`, error: message };
    trace.finishedAt = new Date().toISOString();
    trace.result = result;
    return {
      modelContent: formatToolResult(result, toolCall.function.name, options.sanitize, options.maxModelContentLength),
      trace
    };
  }
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
