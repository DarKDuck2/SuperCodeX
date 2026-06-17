import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeWhitespace } from "../core/text.js";
import { runRegisteredTool } from "../tools/runtime.js";
import { selectToolsForTask } from "../tools/selection.js";
import { htmlToReadableText, looksLikeHtml } from "../web/readability.js";
import type { ToolRuntimeResult } from "../tools/runtime.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolCall, ToolContext, ToolDefinition } from "../tools/types.js";
import type {
  AgentEvent,
  AgentResult,
  AgentRunMode,
  ApiConfig,
  ChatCompletionResponse,
  ChatMessage,
  Conversation,
  LlmCallUsage,
  Message,
  Project,
  StoredMessage,
  TokenUsageMetrics,
  ToolMessage
} from "../domain/types.js";

type CreateAgentRuntimeDependencies = {
  settings: Required<ApiConfig>;
  systemPrompt: string;
  workspaceRoot: string;
  workspaceFilesDirName: string;
  maxAgentTurns: number;
  maxOutputTokens: number;
  recentContextMessageLimit: number;
  maxToolResultChars: number;
  projects: Map<string, Project>;
  toolRegistry: ToolRegistry;
  getConversationAttachments: (conversationId: string) => ToolContext["attachments"];
  latestUserPrompt: (conversation: Conversation) => string;
  getActiveSkillSelection: () => {
    activeSkillIds: string[];
    activeSkillCategories: string[];
    activeSkillKeywords: string[];
  };
  formatAttachmentContext: (items: ToolContext["attachments"]) => string;
  formatSkillContext: () => string;
  summarizeConversation: (conversation: Conversation) => string;
  toChatMessage: (message: StoredMessage, options?: { compact?: boolean }) => ChatMessage;
  persistStore: () => Promise<void>;
  id: (prefix: string) => string;
  now: () => string;
};

export function createAgentRuntime(deps: CreateAgentRuntimeDependencies) {
  const {
    settings,
    systemPrompt,
    workspaceRoot,
    workspaceFilesDirName,
    maxAgentTurns,
    maxOutputTokens,
    recentContextMessageLimit,
    maxToolResultChars,
    projects,
    toolRegistry,
    getConversationAttachments,
    latestUserPrompt,
    getActiveSkillSelection,
    formatAttachmentContext,
    formatSkillContext,
    summarizeConversation,
    toChatMessage,
    persistStore,
    id,
    now
  } = deps;

  async function runAgentLoop(
    conversation: Conversation,
    config?: ApiConfig,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
    mode: AgentRunMode = "agent"
  ): Promise<AgentResult> {
    const project = projects.get(conversation.projectId);
    const conversationAttachments = getConversationAttachments(conversation.id);
    const context: ToolContext = {
      workspacePath: project?.rootPath || workspaceRoot,
      outputPath: path.join(project?.rootPath || workspaceRoot, workspaceFilesDirName),
      attachments: conversationAttachments
    };
    await fs.mkdir(context.outputPath, { recursive: true });
    const outputRelativePath = path.relative(context.workspacePath, context.outputPath) || ".";
    const chatMessages: ChatMessage[] = buildAgentContextMessages(conversation, context, outputRelativePath, mode);
    const toolCalls: AgentResult["toolCalls"] = [];
  
    for (let turns = 1; turns <= maxAgentTurns; turns++) {
      assertNotAborted(signal);
      onEvent?.({ type: "step", turn: turns, message: `第 ${turns} 步：模型正在判断是否需要调用工具。` });
      const selectedToolDefinitions = ensureModeToolDefinitions(selectToolsForTask(toolRegistry.list(), {
        prompt: latestUserPrompt(conversation),
        context,
        ...getActiveSkillSelection()
      }).map((tool) => tool.definition), mode);
      const response = await callLLM(chatMessages, config, true, signal, selectedToolDefinitions);
      const usageCall = recordLlmUsage(conversation, response, {
        config,
        purpose: "agent_turn",
        turn: turns,
        enableTools: true,
        inputMessageCount: chatMessages.length,
        selectedToolCount: selectedToolDefinitions.length
      });
      if (usageCall) onEvent?.({ type: "usage", turn: turns, call: usageCall, totals: conversation.usage!.totals });
      assertNotAborted(signal);
      const message = response.choices?.[0]?.message;
      if (!message) throw new Error("LLM returned no choices");
  
      if (message.tool_calls?.length) {
        const assistantToolMessage: Message = {
          id: id("message"),
          role: "assistant",
          content: message.content?.trim() || "",
          tool_calls: message.tool_calls,
          createdAt: now()
        };
        conversation.messages.push(assistantToolMessage);
        conversation.updatedAt = assistantToolMessage.createdAt;
        onEvent?.({ type: "assistant_tool_call", turn: turns, message: assistantToolMessage });
        chatMessages.push({
          role: "assistant",
          content: message.content || null,
          tool_calls: message.tool_calls
        });
  
        for (const toolCall of message.tool_calls) {
          assertNotAborted(signal);
          onEvent?.({
            type: "step",
            turn: turns,
            message: `第 ${turns} 步：正在执行工具 ${toolCall.function.name}。`
          });
          const execution = await executeToolCall(toolCall, context);
          const result = execution.modelContent;
          assertNotAborted(signal);
          toolCalls.push({
            id: toolCall.id,
            name: toolCall.function.name,
            args: toolCall.function.arguments,
            result,
            trace: execution.trace
          });
  
          const toolMessage: ToolMessage = {
            id: id("message"),
            role: "tool",
            content: result,
            tool_call_id: toolCall.id,
            toolName: toolCall.function.name,
            createdAt: now()
          };
          conversation.messages.push(toolMessage);
          conversation.updatedAt = now();
          onEvent?.({ type: "tool_result", turn: turns, message: toolMessage });
          chatMessages.push({
            role: "tool",
            content: result,
            tool_call_id: toolCall.id,
            name: toolCall.function.name
          });
        }
  
        conversation.summary = summarizeConversation(conversation);
        await persistStore();
        continue;
      }
  
      const finalMessage: Message = {
        id: id("message"),
        role: "assistant",
        content: message.content?.trim() || "模型没有返回内容。",
        createdAt: now()
      };
      conversation.messages.push(finalMessage);
      conversation.updatedAt = finalMessage.createdAt;
      conversation.summary = summarizeConversation(conversation);
      await persistStore();
      onEvent?.({ type: "final", turn: turns, message: finalMessage, conversation, toolCalls, usage: conversation.usage });
      return { finalMessage, toolCalls, turns };
    }
  
    const finalResponse = await callLLM(
      [
        ...chatMessages,
        { role: "system", content: "Tool budget exhausted. Give a final answer from the available evidence." }
      ],
      config,
      false,
      signal
    );
    const usageCall = recordLlmUsage(conversation, finalResponse, {
      config,
      purpose: "agent_final_after_tool_budget",
      turn: maxAgentTurns,
      enableTools: false,
      inputMessageCount: chatMessages.length + 1,
      selectedToolCount: 0
    });
    if (usageCall) onEvent?.({ type: "usage", turn: maxAgentTurns, call: usageCall, totals: conversation.usage!.totals });
    assertNotAborted(signal);
    const finalMessage: Message = {
      id: id("message"),
      role: "assistant",
      content: finalResponse.choices?.[0]?.message?.content?.trim() || "已达到最大工具调用次数限制。",
      createdAt: now()
    };
    conversation.messages.push(finalMessage);
    conversation.updatedAt = finalMessage.createdAt;
    conversation.summary = summarizeConversation(conversation);
    await persistStore();
    onEvent?.({ type: "final", turn: maxAgentTurns, message: finalMessage, conversation, toolCalls, usage: conversation.usage });
    return { finalMessage, toolCalls, turns: maxAgentTurns };
  }
  
  async function callLLM(
    messages: ChatMessage[],
    config?: ApiConfig,
    enableTools = false,
    signal?: AbortSignal,
    selectedToolDefinitions?: ToolDefinition[]
  ) {
    const effective = {
      baseUrl: normalizeBaseUrl(config?.baseUrl || settings.baseUrl),
      apiKey: config?.apiKey || settings.apiKey,
      model: config?.model || settings.model
    };
  
    if (!effective.baseUrl || !effective.apiKey) {
      return {
        choices: [{ message: { content: fallbackOfficeReply(messages), tool_calls: undefined } }]
      } as ChatCompletionResponse;
    }
  
    const toolDefinitions = enableTools ? selectedToolDefinitions ?? getToolDefinitions() : [];
    const upstream = await fetch(`${effective.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${effective.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: effective.model,
        messages,
        ...(toolDefinitions.length > 0 ? { tools: toolDefinitions, tool_choice: "auto" } : {}),
        temperature: 0.2,
        max_tokens: maxOutputTokens
      }),
      signal
    });
  
    const payload = (await upstream.json()) as ChatCompletionResponse;
    if (!upstream.ok) {
      throw new Error(payload.error?.message ?? "Upstream API request failed");
    }
  
    return payload;
  }
  
  function assertNotAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new Error("Agent run aborted");
    }
  }
  
  function getToolDefinitions() {
    return toolRegistry.definitions();
  }
  
  function buildAgentContextMessages(
    conversation: Conversation,
    context: ToolContext,
    outputRelativePath: string,
    mode: AgentRunMode = "agent"
  ): ChatMessage[] {
    const recentMessages = selectRecentContextMessages(conversation.messages);
    const omittedCount = Math.max(0, conversation.messages.length - recentMessages.length);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "system",
        content: [
          `Current local project workspace: ${context.workspacePath}.`,
          `Generated files directory: ${context.outputPath}.`,
          `When the user does not specify an output path, save generated files, scripts, and intermediate outputs under ${outputRelativePath}.`,
          "run_command without cwd runs in the generated files directory. Pass cwd explicitly when you need to run commands from the project root or a subdirectory."
        ].join(" ")
      },
      {
        role: "system",
        content: formatAttachmentContext(context.attachments)
      },
      {
        role: "system",
        content: formatSkillContext()
      }
    ];
  
    if (mode === "team") {
      messages.push({
        role: "system",
        content: formatMetaXTeamModePrompt()
      });
    }
  
    if (omittedCount > 0) {
      messages.push({
        role: "system",
        content: [
          `Conversation memory summary (${omittedCount} older messages omitted from the live prompt):`,
          conversation.summary || summarizeConversation(conversation),
          "Rely on the recent messages below for exact wording. Use tools to re-read files or data when exact details are needed."
        ].join("\n")
      });
    }
  
    messages.push(...recentMessages.map((message) => toChatMessage(message, { compact: true })));
    return messages;
  }
  
  function ensureModeToolDefinitions(definitions: ToolDefinition[], mode: AgentRunMode) {
    if (mode !== "team" || definitions.some((definition) => definition.function.name === "delegate_to_claude_code")) {
      return definitions;
    }
    const claudeCodeTool = toolRegistry.get("delegate_to_claude_code");
    return claudeCodeTool ? [...definitions, claudeCodeTool.definition] : definitions;
  }
  
  function formatMetaXTeamModePrompt() {
    return [
      "Agent cluster mode is enabled. Use the MetaX orchestration pattern: compile the user request into a clear task spec, route work to specialized sub-agents, run primary work before review, then aggregate the final answer.",
      "Available logical sub-agents:",
      "- ClaudeCodeAgent: replaces MetaX CodingAgent. For implementation, debugging, refactoring, repository edits, and tests, call delegate_to_claude_code with a precise task brief. Treat Claude Code as the executor and SuperCodex as supervisor.",
      "- ResearchAgent: use SuperCodex web, file, attachment, and reading tools for discovery, synthesis, source checking, and context gathering.",
      "- ReviewAgent: after primary work, inspect outputs, risks, acceptance criteria, and verification evidence before the final answer.",
      "Routing rules: select ClaudeCodeAgent when needs.code=true; select ResearchAgent when needs.research=true; select ReviewAgent whenever the task asks for review or after any code/research route. If no route is obvious, default to ClaudeCodeAgent only for local project/code work, otherwise use the ordinary SuperCodex tool flow.",
      "Final answer should briefly name the selected route, summarize each sub-agent result, list generated artifacts or verification, and call out unresolved risks."
    ].join("\n");
  }
  
  function selectRecentContextMessages(messages: StoredMessage[]) {
    const recent = messages.slice(-recentContextMessageLimit);
    while (recent[0]?.role === "tool") {
      recent.shift();
    }
    return recent;
  }
  
  function recordLlmUsage(
    conversation: Conversation,
    response: ChatCompletionResponse,
    input: {
      config?: ApiConfig;
      purpose: string;
      turn?: number;
      enableTools: boolean;
      inputMessageCount: number;
      selectedToolCount: number;
    }
  ) {
    const usage = normalizeUsage(response.usage);
    if (!usage) return undefined;
    const call: LlmCallUsage = {
      id: id("usage"),
      model: response.model || input.config?.model || settings.model,
      purpose: input.purpose,
      turn: input.turn,
      enableTools: input.enableTools,
      inputMessageCount: input.inputMessageCount,
      selectedToolCount: input.selectedToolCount,
      createdAt: now(),
      usage
    };
    const previous = conversation.usage?.calls || [];
    const calls = [...previous, call].slice(-500);
    conversation.usage = {
      calls,
      totals: sumUsage(calls.map((item) => item.usage)),
      updatedAt: call.createdAt
    };
    return call;
  }

  function normalizeUsage(usage: unknown): TokenUsageMetrics | undefined {
    if (!usage || typeof usage !== "object") return undefined;
    const input = usage as Record<string, unknown>;
    const inputTokens = numericUsage(input, "input_tokens", "prompt_tokens");
    const outputTokens = numericUsage(input, "output_tokens", "completion_tokens");
    const totalTokens = numericUsage(input, "total_tokens") || inputTokens + outputTokens;
    const cacheHitTokens = numericUsage(input, "cache_hit_tokens", "prompt_cache_hit_tokens", "cached_tokens");
    const cacheMissTokens = numericUsage(input, "cache_miss_tokens", "prompt_cache_miss_tokens");
    return { inputTokens, outputTokens, totalTokens, cacheHitTokens, cacheMissTokens };
  }
  
  function numericUsage(input: Record<string, unknown>, ...keys: string[]) {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return 0;
  }
  
  function sumUsage(items: TokenUsageMetrics[]): TokenUsageMetrics {
    return items.reduce(
      (total, item) => ({
        inputTokens: total.inputTokens + item.inputTokens,
        outputTokens: total.outputTokens + item.outputTokens,
        totalTokens: total.totalTokens + item.totalTokens,
        cacheHitTokens: total.cacheHitTokens + item.cacheHitTokens,
        cacheMissTokens: total.cacheMissTokens + item.cacheMissTokens
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
    );
  }
  
  async function executeToolCall(toolCall: ToolCall, context: ToolContext): Promise<ToolRuntimeResult> {
    const tool = toolRegistry.get(toolCall.function.name);
    if (!tool) {
      const reason = `Unknown tool: ${toolCall.function.name}`;
      return {
        modelContent: reason,
        trace: {
          id: toolCall.id,
          toolName: toolCall.function.name,
          args: {},
          policy: { action: "deny", reason },
          startedAt: now(),
          finishedAt: now(),
          result: { ok: false, summary: reason, error: reason }
        }
      };
    }
    return runRegisteredTool(toolCall, tool, context, {
      sanitize: sanitizeToolResult,
      maxModelContentLength: maxToolResultChars
    });
  }
  
  function sanitizeToolResult(toolName: string, result: string) {
    if (!looksLikeHtml(result)) return result;
    return [
      `${toolName} returned HTML-like content. SuperCodex extracted readable text instead of raw markup.`,
      htmlToReadableText(result)
    ].join("\n");
  }
  
  function fallbackOfficeReply(messages: ChatMessage[]) {
    const task = [...messages].reverse().find((message) => message.role === "user")?.content || "这个任务";
    return [
      `我已经收到：${task}`,
      "",
      "当前未配置模型 API，我会以本地模式给出处理框架：",
      "1. 明确目标和交付物。",
      "2. 收集相关邮件、文档、聊天记录或网页资料。",
      "3. 提炼结论、风险和下一步行动。",
      "4. 生成可复用的回复、报告、清单或自动化流程。"
    ].join("\n");
  }
  
  function normalizeBaseUrl(value?: string) {
    return value ? value.replace(/\/$/, "") : "";
  }

  return {
    runAgentLoop,
    callLLM,
    getToolDefinitions
  };
}
