import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeWhitespace } from "../core/text.js";
import { selectPipelineDefinition } from "./pipeline.js";
import { runRegisteredTool } from "../tools/runtime.js";
import { selectToolsForTask } from "../tools/selection.js";
import { htmlToReadableText, looksLikeHtml } from "../web/readability.js";
import {
  buildReviewPrompt,
  fallbackReviewVerdict,
  formatSkillContextBundles,
  formatTaskSpec,
  generateTaskSpec,
  getSkillContextBundles,
  parseReviewVerdict
} from "./spec.js";
import type { AgentRole } from "./pipeline.js";
import type { ReviewVerdict, SkillContextBundle, TaskSpec } from "./spec.js";
import type { ToolRuntimeResult } from "../tools/runtime.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolCall, ToolContext, ToolDefinition } from "../tools/types.js";
import type {
  AgentEvent,
  AgentResult,
  AgentRunMode,
  AgentRunOptions,
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

type AgentRunSession = {
  conversation: Conversation;
  config?: ApiConfig;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  mode: AgentRunMode;
  context: ToolContext;
  chatMessages: ChatMessage[];
  toolCalls: AgentResult["toolCalls"];
};

type SubAgentSpec = {
  role: AgentRole;
  systemPrompt: string;
  allowedToolNames: string[];
  maxTurns: number;
};

type SubAgentResult = {
  role: AgentRole;
  agentId: string;
  status: "completed" | "failed" | "aborted";
  turns: number;
  summary: string;
  finalContent: string;
  toolCalls: AgentResult["toolCalls"];
};

type DeliveryPipelineContext = {
  taskSpec: TaskSpec;
  skillBundles: SkillContextBundle[];
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

  const subAgentSpecs: Record<AgentRole, SubAgentSpec> = {
    CodeAgent: {
      role: "CodeAgent",
      systemPrompt: [
        "You are CodeAgent, a focused implementation agent.",
        "Handle coding, debugging, refactoring, and tests. Prefer delegate_to_claude_code for repository edits.",
        "Return changed files, verification, and unresolved issues."
      ].join(" "),
      allowedToolNames: [
        "delegate_to_claude_code",
        "read_file",
        "search_files",
        "replace_in_file",
        "run_tests",
        "list_directory",
        "run_command"
      ],
      maxTurns: Math.min(maxAgentTurns, 30)
    },
    ResearchAgent: {
      role: "ResearchAgent",
      systemPrompt: [
        "You are ResearchAgent, a concise discovery and fact-checking agent.",
        "Use web, file, and attachment tools to gather evidence. Include source attribution when web sources are used.",
        "Return key findings, sources, confidence, and gaps."
      ].join(" "),
      allowedToolNames: [
        "search_web",
        "fetch_url",
        "read_file",
        "search_files",
        "list_attachments",
        "read_attachment",
        "extract_pdf_text",
        "read_spreadsheet",
        "extract_docx_text",
        "inspect_presentation"
      ],
      maxTurns: Math.min(maxAgentTurns, 15)
    },
    ReviewAgent: {
      role: "ReviewAgent",
      systemPrompt: [
        "You are ReviewAgent, a skeptical verification agent.",
        "Inspect upstream results, check acceptance criteria, run lightweight verification when useful, and identify risks.",
        "Return a verdict, issues, and recommendations."
      ].join(" "),
      allowedToolNames: ["read_file", "search_files", "run_tests", "list_directory"],
      maxTurns: Math.min(maxAgentTurns, 15)
    },
    OfficeAgent: {
      role: "OfficeAgent",
      systemPrompt: [
        "You are OfficeAgent, a document and artifact processing agent.",
        "Work with PDFs, DOCX, PPTX, spreadsheets, images, and generated office deliverables.",
        "Return artifacts, processing summary, and any formatting or data issues."
      ].join(" "),
      allowedToolNames: [
        "extract_pdf_text",
        "extract_docx_text",
        "inspect_presentation",
        "read_spreadsheet",
        "create_spreadsheet",
        "transform_image",
        "read_file",
        "write_file",
        "list_attachments",
        "read_attachment"
      ],
      maxTurns: Math.min(maxAgentTurns, 15)
    }
  };

  async function runAgentLoop(
    conversation: Conversation,
    config?: ApiConfig,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
    mode: AgentRunMode = "agent",
    options: AgentRunOptions = {}
  ): Promise<AgentResult> {
    if (mode === "team") {
      return runTeamPipeline(conversation, config, onEvent, signal, options);
    }
    return runStandardAgentLoop(conversation, config, onEvent, signal, mode);
  }

  async function runTeamPipeline(
    conversation: Conversation,
    config?: ApiConfig,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
    options: AgentRunOptions = {}
  ): Promise<AgentResult> {
    const session = await createAgentRunSession(conversation, config, onEvent, signal, "team");
    const taskSpec = generateTaskSpec({
      prompt: latestUserPrompt(conversation),
      context: session.context,
      ...getActiveSkillSelection(),
      deliveryMode: options.deliveryMode,
      id
    });
    const skillBundles = getSkillContextBundles(taskSpec.requiredSkills);
    const deliveryContext: DeliveryPipelineContext = { taskSpec, skillBundles };
    const pipeline = selectPipelineDefinition(taskSpec);
    const pipelineId = id("pipeline");

    onEvent?.({
      type: "task_spec",
      pipelineId,
      spec: taskSpec,
      skillBundles
    });

    onEvent?.({
      type: "team_pipeline_start",
      pipelineId,
      template: pipeline.template,
      stages: pipeline.stages.map((stage) => ({
        name: stage.name,
        parallel: stage.parallel,
        agents: stage.agents.map((role) => ({ role, toolCount: availableToolCountForSubAgent(role) }))
      }))
    });

    const subAgentResults: SubAgentResult[] = [];
    const handoffs: string[] = [];
    for (const [stageIndex, stage] of pipeline.stages.entries()) {
      assertNotAborted(signal);
      const stageResults = await Promise.all(
        stage.agents.map((role) =>
          runSubAgentSession({
            conversation,
            config,
            context: session.context,
            pipelineId,
            stageIndex,
            role,
            handoffs,
            deliveryContext,
            onEvent,
            signal
          })
        )
      );
      subAgentResults.push(...stageResults);
      handoffs.push(...stageResults.map(formatSubAgentHandoff));
      onEvent?.({ type: "stage_done", pipelineId, stageIndex });
    }

    const reviewResult = await runAcceptanceReview({
      conversation,
      config,
      pipelineId,
      taskSpec,
      subAgentResults,
      onEvent,
      signal,
      iteration: 0
    });
    subAgentResults.push(reviewResult.subAgentResult);
    let finalReview = reviewResult.verdict;

    for (let repairIndex = 1; repairIndex <= taskSpec.maxIterations && !finalReview.passed; repairIndex++) {
      const repairResults = await runRepairIteration({
        conversation,
        config,
        context: session.context,
        pipelineId,
        stageIndex: pipeline.stages.length + repairIndex - 1,
        iteration: repairIndex,
        deliveryContext,
        handoffs: [
          ...subAgentResults.map(formatSubAgentHandoff),
          formatReviewRepairBrief(finalReview)
        ],
        onEvent,
        signal
      });
      subAgentResults.push(...repairResults);
      const nextReview = await runAcceptanceReview({
        conversation,
        config,
        pipelineId,
        taskSpec,
        subAgentResults,
        onEvent,
        signal,
        iteration: repairIndex
      });
      subAgentResults.push(nextReview.subAgentResult);
      finalReview = nextReview.verdict;
    }

    const result = await finalizeTeamPipeline(conversation, config, onEvent, signal, pipeline.template, subAgentResults, taskSpec, finalReview);
    onEvent?.({
      type: "final",
      turn: result.turns,
      message: result.finalMessage,
      conversation,
      toolCalls: result.toolCalls,
      usage: conversation.usage
    });
    onEvent?.({
      type: "team_final",
      pipelineId,
      pipeline,
      finalMessage: result.finalMessage,
      subAgentResults
    });
    return result;
  }

  async function runSubAgentSession(input: {
    conversation: Conversation;
    config?: ApiConfig;
    context: ToolContext;
    pipelineId: string;
    stageIndex: number;
    role: AgentRole;
    handoffs: string[];
    deliveryContext?: DeliveryPipelineContext;
    onEvent?: (event: AgentEvent) => void;
    signal?: AbortSignal;
  }): Promise<SubAgentResult> {
    const spec = subAgentSpecs[input.role];
    const agentId = id("agent");
    const toolCalls: AgentResult["toolCalls"] = [];
    const chatMessages = buildSubAgentContextMessages(
      input.conversation,
      input.context,
      spec,
      input.handoffs,
      input.deliveryContext
    );

    input.onEvent?.({
      type: "sub_agent_start",
      pipelineId: input.pipelineId,
      stageIndex: input.stageIndex,
      agentRole: spec.role,
      agentId
    });

    try {
      for (let turn = 1; turn <= spec.maxTurns; turn++) {
        assertNotAborted(input.signal);
        input.onEvent?.({
          type: "sub_agent_step",
          pipelineId: input.pipelineId,
          stageIndex: input.stageIndex,
          agentRole: spec.role,
          turn,
          message: `${spec.role} turn ${turn}`
        });

        const selectedToolDefinitions = selectToolDefinitionsForSubAgent(spec, input.conversation, input.context);
        const response = await callLLM(chatMessages, input.config, true, input.signal, selectedToolDefinitions);
        const usageCall = recordLlmUsage(input.conversation, response, {
          config: input.config,
          purpose: `sub_agent_${spec.role}`,
          turn,
          enableTools: true,
          inputMessageCount: chatMessages.length,
          selectedToolCount: selectedToolDefinitions.length
        });
        if (usageCall) {
          input.onEvent?.({ type: "usage", turn, call: usageCall, totals: input.conversation.usage!.totals });
        }
        assertNotAborted(input.signal);

        const message = response.choices?.[0]?.message;
        if (!message) throw new Error("LLM returned no choices");

        if (message.tool_calls?.length) {
          chatMessages.push({
            role: "assistant",
            content: message.content || null,
            tool_calls: message.tool_calls
          });
          for (const toolCall of message.tool_calls) {
            assertNotAborted(input.signal);
            input.onEvent?.({
              type: "sub_agent_tool_call",
              pipelineId: input.pipelineId,
              stageIndex: input.stageIndex,
              agentRole: spec.role,
              toolName: toolCall.function.name,
              args: toolCall.function.arguments
            });
            const execution = await executeToolCall(toolCall, input.context);
            const result = execution.modelContent;
            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              args: toolCall.function.arguments,
              result,
              trace: execution.trace
            });
            input.onEvent?.({
              type: "sub_agent_tool_result",
              pipelineId: input.pipelineId,
              stageIndex: input.stageIndex,
              agentRole: spec.role,
              result
            });
            chatMessages.push({
              role: "tool",
              content: result,
              tool_call_id: toolCall.id,
              name: toolCall.function.name
            });
          }
          continue;
        }

        const finalContent = message.content?.trim() || `${spec.role} completed without a textual result.`;
        const summary = summarizeSubAgentResult(spec.role, finalContent, toolCalls);
        input.onEvent?.({
          type: "sub_agent_done",
          pipelineId: input.pipelineId,
          stageIndex: input.stageIndex,
          agentRole: spec.role,
          summary
        });
        return {
          role: spec.role,
          agentId,
          status: "completed",
          turns: turn,
          summary,
          finalContent,
          toolCalls
        };
      }

      const finalContent = `${spec.role} reached its turn budget.`;
      const summary = summarizeSubAgentResult(spec.role, finalContent, toolCalls);
      input.onEvent?.({
        type: "sub_agent_done",
        pipelineId: input.pipelineId,
        stageIndex: input.stageIndex,
        agentRole: spec.role,
        summary
      });
      return {
        role: spec.role,
        agentId,
        status: "completed",
        turns: spec.maxTurns,
        summary,
        finalContent,
        toolCalls
      };
    } catch (error) {
      const aborted = input.signal?.aborted;
      const message = error instanceof Error ? error.message : "Unknown sub-agent error";
      const summary = `[${spec.role} Result]\nStatus: ${aborted ? "Aborted" : "Failed"}\nIssues: ${message}`;
      input.onEvent?.({
        type: "sub_agent_done",
        pipelineId: input.pipelineId,
        stageIndex: input.stageIndex,
        agentRole: spec.role,
        summary
      });
      return {
        role: spec.role,
        agentId,
        status: aborted ? "aborted" : "failed",
        turns: 0,
        summary,
        finalContent: message,
        toolCalls
      };
    }
  }

  async function runAcceptanceReview(input: {
    conversation: Conversation;
    config?: ApiConfig;
    pipelineId: string;
    taskSpec: TaskSpec;
    subAgentResults: SubAgentResult[];
    onEvent?: (event: AgentEvent) => void;
    signal?: AbortSignal;
    iteration: number;
  }): Promise<{ verdict: ReviewVerdict; subAgentResult: SubAgentResult }> {
    assertNotAborted(input.signal);
    const agentId = id("agent");
    const handoffs = input.subAgentResults.map(formatSubAgentHandoff);
    input.onEvent?.({
      type: "sub_agent_start",
      pipelineId: input.pipelineId,
      stageIndex: -1,
      agentRole: "ReviewAgent",
      agentId
    });
    input.onEvent?.({
      type: "sub_agent_step",
      pipelineId: input.pipelineId,
      stageIndex: -1,
      agentRole: "ReviewAgent",
      turn: input.iteration + 1,
      message: `Acceptance review iteration ${input.iteration}`
    });

    let verdict: ReviewVerdict;
    let rawContent = "";
    try {
      const response = await callLLM(
        [
          {
            role: "system",
            content: "You are ReviewAgent. Judge the delivery strictly against the TaskSpec. Return JSON only."
          },
          {
            role: "user",
            content: buildReviewPrompt(input.taskSpec, handoffs, input.iteration)
          }
        ],
        input.config,
        false,
        input.signal
      );
      const usageCall = recordLlmUsage(input.conversation, response, {
        config: input.config,
        purpose: "acceptance_review",
        turn: input.iteration,
        enableTools: false,
        inputMessageCount: 2,
        selectedToolCount: 0
      });
      if (usageCall) {
        input.onEvent?.({ type: "usage", turn: input.iteration, call: usageCall, totals: input.conversation.usage!.totals });
      }
      rawContent = response.choices?.[0]?.message?.content?.trim() || "";
      verdict = rawContent ? parseReviewVerdict(rawContent) : fallbackReviewVerdict("ReviewAgent returned no content.");
    } catch (error) {
      verdict = fallbackReviewVerdict(error instanceof Error ? error.message : "ReviewAgent failed.");
      rawContent = verdict.summary;
    }

    const finalContent = [
      formatReviewVerdict(verdict),
      rawContent && !rawContent.includes(verdict.summary) ? `Raw review:\n${rawContent}` : ""
    ].filter(Boolean).join("\n\n");
    const summary = truncateHandoff(
      [
        "[ReviewAgent Result]",
        `Status: ${verdict.passed ? "Completed" : "Failed"}`,
        `Score: ${verdict.score.toFixed(2)}`,
        `Summary: ${verdict.summary}`,
        verdict.failedCriteria.length ? `Failed criteria: ${verdict.failedCriteria.join("; ")}` : "",
        verdict.requiredFixes.length ? `Required fixes: ${verdict.requiredFixes.join("; ")}` : ""
      ].filter(Boolean).join("\n")
    );

    input.onEvent?.({
      type: "review_verdict",
      pipelineId: input.pipelineId,
      iteration: input.iteration,
      verdict
    });
    input.onEvent?.({
      type: "sub_agent_done",
      pipelineId: input.pipelineId,
      stageIndex: -1,
      agentRole: "ReviewAgent",
      summary
    });

    return {
      verdict,
      subAgentResult: {
        role: "ReviewAgent",
        agentId,
        status: verdict.passed ? "completed" : "failed",
        turns: 1,
        summary,
        finalContent,
        toolCalls: []
      }
    };
  }

  async function runRepairIteration(input: {
    conversation: Conversation;
    config?: ApiConfig;
    context: ToolContext;
    pipelineId: string;
    stageIndex: number;
    iteration: number;
    deliveryContext: DeliveryPipelineContext;
    handoffs: string[];
    onEvent?: (event: AgentEvent) => void;
    signal?: AbortSignal;
  }) {
    const roles = selectRepairRoles(input.deliveryContext.taskSpec);
    input.onEvent?.({
      type: "repair_iteration_start",
      pipelineId: input.pipelineId,
      iteration: input.iteration,
      roles
    });
    const results = await Promise.all(
      roles.map((role) =>
        runSubAgentSession({
          conversation: input.conversation,
          config: input.config,
          context: input.context,
          pipelineId: input.pipelineId,
          stageIndex: input.stageIndex,
          role,
          handoffs: input.handoffs,
          deliveryContext: input.deliveryContext,
          onEvent: input.onEvent,
          signal: input.signal
        })
      )
    );
    input.onEvent?.({ type: "stage_done", pipelineId: input.pipelineId, stageIndex: input.stageIndex });
    return results;
  }

  function selectRepairRoles(taskSpec: TaskSpec): AgentRole[] {
    const domains = new Set(taskSpec.domains);
    const roles: AgentRole[] = [];
    if (domains.has("research")) roles.push("ResearchAgent");
    if (["office", "presentation", "spreadsheet", "document", "pdf", "image"].some((domain) => domains.has(domain as TaskSpec["domains"][number]))) {
      roles.push("OfficeAgent");
    }
    if (domains.has("code")) roles.push("CodeAgent");
    return roles.length ? roles : ["CodeAgent"];
  }

  function formatReviewRepairBrief(verdict: ReviewVerdict) {
    return [
      "[Acceptance Review Repair Brief]",
      `Passed: ${verdict.passed}`,
      `Score: ${verdict.score.toFixed(2)}`,
      verdict.failedCriteria.length ? `Failed criteria:\n${verdict.failedCriteria.map((item) => `- ${item}`).join("\n")}` : "",
      verdict.requiredFixes.length ? `Required fixes:\n${verdict.requiredFixes.map((item) => `- ${item}`).join("\n")}` : "",
      verdict.risks.length ? `Risks:\n${verdict.risks.map((item) => `- ${item}`).join("\n")}` : ""
    ].filter(Boolean).join("\n");
  }

  function formatReviewVerdict(verdict: ReviewVerdict) {
    return [
      "Acceptance review:",
      `- Passed: ${verdict.passed}`,
      `- Score: ${verdict.score.toFixed(2)}`,
      `- Summary: ${verdict.summary}`,
      verdict.failedCriteria.length ? `- Failed criteria: ${verdict.failedCriteria.join("; ")}` : "",
      verdict.requiredFixes.length ? `- Required fixes: ${verdict.requiredFixes.join("; ")}` : "",
      verdict.risks.length ? `- Risks: ${verdict.risks.join("; ")}` : ""
    ].filter(Boolean).join("\n");
  }

  async function finalizeTeamPipeline(
    conversation: Conversation,
    config: ApiConfig | undefined,
    onEvent: ((event: AgentEvent) => void) | undefined,
    signal: AbortSignal | undefined,
    template: string,
    subAgentResults: SubAgentResult[],
    taskSpec?: TaskSpec,
    reviewVerdict?: ReviewVerdict
  ): Promise<AgentResult> {
    const prompt = latestUserPrompt(conversation);
    const aggregateToolCalls = subAgentResults.flatMap((result) => result.toolCalls);
    const finalResponse = await callLLM(
      [
        { role: "system", content: "You are the team orchestrator. Merge sub-agent results into a concise final answer for the user. Mention verification and unresolved risks." },
        { role: "user", content: prompt },
        {
          role: "system",
          content: [
            `Pipeline template: ${template}`,
            taskSpec ? formatTaskSpec(taskSpec) : "",
            reviewVerdict ? formatReviewVerdict(reviewVerdict) : "",
            "Sub-agent handoffs:",
            subAgentResults.map(formatSubAgentHandoff).join("\n\n") || "(No sub-agent results.)"
          ].filter(Boolean).join("\n")
        }
      ],
      config,
      false,
      signal
    );
    const usageCall = recordLlmUsage(conversation, finalResponse, {
      config,
      purpose: "team_final",
      enableTools: false,
      inputMessageCount: 3,
      selectedToolCount: 0
    });
    if (usageCall) onEvent?.({ type: "usage", turn: 0, call: usageCall, totals: conversation.usage!.totals });
    assertNotAborted(signal);
    const fallback = [
      "Team mode completed.",
      "",
      subAgentResults.map((result) => result.summary).join("\n\n")
    ].join("\n");
    const finalMessage: Message = {
      id: id("message"),
      role: "assistant",
      content: finalResponse.choices?.[0]?.message?.content?.trim() || fallback,
      createdAt: now()
    };
    conversation.messages.push(finalMessage);
    conversation.updatedAt = finalMessage.createdAt;
    conversation.summary = summarizeConversation(conversation);
    await persistStore();
    return {
      finalMessage,
      toolCalls: aggregateToolCalls,
      turns: subAgentResults.reduce((total, result) => total + result.turns, 0)
    };
  }

  function buildSubAgentContextMessages(
    conversation: Conversation,
    context: ToolContext,
    spec: SubAgentSpec,
    handoffs: string[],
    deliveryContext?: DeliveryPipelineContext
  ): ChatMessage[] {
    const recentMessages = selectRecentContextMessages(conversation.messages);
    const omittedCount = Math.max(0, conversation.messages.length - recentMessages.length);
    const messages: ChatMessage[] = [
      { role: "system", content: spec.systemPrompt },
      {
        role: "system",
        content: [
          `Current local project workspace: ${context.workspacePath}.`,
          `Generated files directory: ${context.outputPath}.`,
          "You are running as an isolated sub-agent. Do not assume other sub-agents can see your private tool outputs unless you summarize them clearly."
        ].join(" ")
      },
      { role: "system", content: formatAttachmentContext(context.attachments) },
      { role: "system", content: formatSkillContext() }
    ];

    if (deliveryContext) {
      messages.push(
        { role: "system", content: formatTaskSpec(deliveryContext.taskSpec) },
        { role: "system", content: formatSkillContextBundles(deliveryContext.skillBundles) }
      );
    }

    if (handoffs.length) {
      messages.push({
        role: "system",
        content: ["Upstream sub-agent handoffs:", ...handoffs].join("\n\n")
      });
    }

    if (omittedCount > 0) {
      messages.push({
        role: "system",
        content: [
          `Conversation memory summary (${omittedCount} older messages omitted from the live prompt):`,
          conversation.summary || summarizeConversation(conversation)
        ].join("\n")
      });
    }

    messages.push(...recentMessages.map((message) => toChatMessage(message, { compact: true })));
    return messages;
  }

  function selectToolDefinitionsForSubAgent(
    spec: SubAgentSpec,
    conversation: Conversation,
    context: ToolContext
  ) {
    const allowed = new Set(spec.allowedToolNames);
    return selectToolsForTask(toolRegistry.list(), {
      prompt: latestUserPrompt(conversation),
      context,
      ...getActiveSkillSelection()
    })
      .filter((tool) => allowed.has(tool.definition.function.name))
      .map((tool) => tool.definition);
  }

  function availableToolCountForSubAgent(role: AgentRole) {
    const allowed = new Set(subAgentSpecs[role].allowedToolNames);
    return toolRegistry.list().filter((tool) => allowed.has(tool.definition.function.name)).length;
  }

  function summarizeSubAgentResult(role: AgentRole, finalContent: string, toolCalls: AgentResult["toolCalls"]) {
    const toolSummary = toolCalls.length
      ? `Tools used: ${toolCalls.map((toolCall) => toolCall.name).join(", ")}`
      : "Tools used: none";
    return truncateHandoff(
      [`[${role} Result]`, "Status: Completed", toolSummary, "Summary:", finalContent].join("\n")
    );
  }

  function formatSubAgentHandoff(result: SubAgentResult) {
    return truncateHandoff(
      [
        `[${result.role} Result]`,
        `Agent ID: ${result.agentId}`,
        `Status: ${result.status}`,
        `Turns: ${result.turns}`,
        result.summary
      ].join("\n")
    );
  }

  function truncateHandoff(value: string) {
    const maxHandoffChars = Number(process.env.MAX_HANDOFF_CHARS || 1500);
    if (value.length <= maxHandoffChars) return value;
    return `${value.slice(0, Math.max(0, maxHandoffChars - 40)).trimEnd()}\n[handoff truncated]`;
  }

  async function runStandardAgentLoop(
    conversation: Conversation,
    config?: ApiConfig,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
    mode: AgentRunMode = "agent"
  ): Promise<AgentResult> {
    const session = await createAgentRunSession(conversation, config, onEvent, signal, mode);
  
    for (let turns = 1; turns <= maxAgentTurns; turns++) {
      const turnResult = await runAgentTurn(session, turns);
      if (turnResult.status === "continue") {
        continue;
      }
      return turnResult.result;
    }
  
    return finalizeAfterToolBudget(session);
  }

  async function createAgentRunSession(
    conversation: Conversation,
    config?: ApiConfig,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
    mode: AgentRunMode = "agent"
  ): Promise<AgentRunSession> {
    const project = projects.get(conversation.projectId);
    const context: ToolContext = {
      workspacePath: project?.rootPath || workspaceRoot,
      outputPath: path.join(project?.rootPath || workspaceRoot, workspaceFilesDirName),
      attachments: getConversationAttachments(conversation.id)
    };
    await fs.mkdir(context.outputPath, { recursive: true });
    const outputRelativePath = path.relative(context.workspacePath, context.outputPath) || ".";
    return {
      conversation,
      config,
      onEvent,
      signal,
      mode,
      context,
      chatMessages: buildAgentContextMessages(conversation, context, outputRelativePath, mode),
      toolCalls: []
    };
  }

  async function runAgentTurn(
    session: AgentRunSession,
    turn: number
  ): Promise<{ status: "continue" } | { status: "done"; result: AgentResult }> {
    assertNotAborted(session.signal);
    session.onEvent?.({ type: "step", turn, message: `第 ${turn} 步：模型正在判断是否需要调用工具。` });
    const selectedToolDefinitions = selectToolDefinitionsForSession(session);
    const response = await callLLM(
      session.chatMessages,
      session.config,
      true,
      session.signal,
      selectedToolDefinitions
    );
    emitUsage(session, response, {
      purpose: "agent_turn",
      turn,
      enableTools: true,
      inputMessageCount: session.chatMessages.length,
      selectedToolCount: selectedToolDefinitions.length
    });
    assertNotAborted(session.signal);
    const message = response.choices?.[0]?.message;
    if (!message) throw new Error("LLM returned no choices");

    if (message.tool_calls?.length) {
      appendAssistantToolCallMessage(session, turn, message.content || "", message.tool_calls);
      await executeToolCallsForTurn(session, turn, message.tool_calls);
      await persistConversationProgress(session.conversation);
      return { status: "continue" };
    }

    const finalMessage = await appendFinalMessage(
      session,
      message.content?.trim() || "模型没有返回内容。"
    );
    session.onEvent?.({
      type: "final",
      turn,
      message: finalMessage,
      conversation: session.conversation,
      toolCalls: session.toolCalls,
      usage: session.conversation.usage
    });
    return { status: "done", result: { finalMessage, toolCalls: session.toolCalls, turns: turn } };
  }

  function selectToolDefinitionsForSession(session: AgentRunSession) {
    return ensureModeToolDefinitions(
      selectToolsForTask(toolRegistry.list(), {
        prompt: latestUserPrompt(session.conversation),
        context: session.context,
        ...getActiveSkillSelection()
      }).map((tool) => tool.definition),
      session.mode
    );
  }

  function appendAssistantToolCallMessage(
    session: AgentRunSession,
    turn: number,
    content: string,
    toolCallsForTurn: ToolCall[]
  ) {
    const assistantToolMessage: Message = {
      id: id("message"),
      role: "assistant",
      content: content.trim(),
      tool_calls: toolCallsForTurn,
      createdAt: now()
    };
    session.conversation.messages.push(assistantToolMessage);
    session.conversation.updatedAt = assistantToolMessage.createdAt;
    session.onEvent?.({ type: "assistant_tool_call", turn, message: assistantToolMessage });
    session.chatMessages.push({
      role: "assistant",
      content: content || null,
      tool_calls: toolCallsForTurn
    });
  }

  async function executeToolCallsForTurn(session: AgentRunSession, turn: number, toolCallsForTurn: ToolCall[]) {
    for (const toolCall of toolCallsForTurn) {
      assertNotAborted(session.signal);
      session.onEvent?.({
        type: "step",
        turn,
        message: `第 ${turn} 步：正在执行工具 ${toolCall.function.name}。`
      });
      const execution = await executeToolCall(toolCall, session.context);
      const result = execution.modelContent;
      assertNotAborted(session.signal);
      session.toolCalls.push({
        id: toolCall.id,
        name: toolCall.function.name,
        args: toolCall.function.arguments,
        result,
        trace: execution.trace
      });
      appendToolResultMessage(session, turn, toolCall, result);
    }
  }

  function appendToolResultMessage(
    session: AgentRunSession,
    turn: number,
    toolCall: ToolCall,
    result: string
  ) {
    const toolMessage: ToolMessage = {
      id: id("message"),
      role: "tool",
      content: result,
      tool_call_id: toolCall.id,
      toolName: toolCall.function.name,
      createdAt: now()
    };
    session.conversation.messages.push(toolMessage);
    session.conversation.updatedAt = toolMessage.createdAt;
    session.onEvent?.({ type: "tool_result", turn, message: toolMessage });
    session.chatMessages.push({
      role: "tool",
      content: result,
      tool_call_id: toolCall.id,
      name: toolCall.function.name
    });
  }

  async function appendFinalMessage(session: AgentRunSession, content: string) {
    const finalMessage: Message = {
      id: id("message"),
      role: "assistant",
      content,
      createdAt: now()
    };
    session.conversation.messages.push(finalMessage);
    session.conversation.updatedAt = finalMessage.createdAt;
    await persistConversationProgress(session.conversation);
    return finalMessage;
  }

  async function persistConversationProgress(conversation: Conversation) {
    conversation.summary = summarizeConversation(conversation);
    await persistStore();
  }

  async function finalizeAfterToolBudget(session: AgentRunSession): Promise<AgentResult> {
    const finalMessages = [
      ...session.chatMessages,
      { role: "system" as const, content: "Tool budget exhausted. Give a final answer from the available evidence." }
    ];
    const finalResponse = await callLLM(finalMessages, session.config, false, session.signal);
    emitUsage(session, finalResponse, {
      purpose: "agent_final_after_tool_budget",
      turn: maxAgentTurns,
      enableTools: false,
      inputMessageCount: finalMessages.length,
      selectedToolCount: 0
    });
    assertNotAborted(session.signal);
    const finalMessage = await appendFinalMessage(
      session,
      finalResponse.choices?.[0]?.message?.content?.trim() || "已达到最大工具调用次数限制。"
    );
    session.onEvent?.({
      type: "final",
      turn: maxAgentTurns,
      message: finalMessage,
      conversation: session.conversation,
      toolCalls: session.toolCalls,
      usage: session.conversation.usage
    });
    return { finalMessage, toolCalls: session.toolCalls, turns: maxAgentTurns };
  }

  function emitUsage(
    session: AgentRunSession,
    response: ChatCompletionResponse,
    input: {
      purpose: string;
      turn?: number;
      enableTools: boolean;
      inputMessageCount: number;
      selectedToolCount: number;
    }
  ) {
    const usageCall = recordLlmUsage(session.conversation, response, {
      config: session.config,
      ...input
    });
    if (usageCall) {
      session.onEvent?.({
        type: "usage",
        turn: input.turn ?? 0,
        call: usageCall,
        totals: session.conversation.usage!.totals
      });
    }
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
