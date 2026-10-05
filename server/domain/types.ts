import type { ToolCall, ToolTrace } from "../tools/types.js";
import type { PipelineDefinition, PipelineTemplate } from "../agent/pipeline.js";
import type { ReviewVerdict, SkillContextBundle, TaskSpec } from "../agent/spec.js";

export type Role = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ApiConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

export type AgentRunMode = "agent" | "team";

export type DeliveryMode = "fast" | "standard" | "strict";

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls?: ToolCall[];
  attachments?: PublicAttachment[];
  createdAt: string;
};

export type ToolMessage = {
  id: string;
  role: "tool";
  content: string;
  tool_call_id: string;
  toolName: string;
  createdAt: string;
};

export type StoredMessage = Message | ToolMessage;

export type Conversation = {
  id: string;
  projectId: string;
  title: string;
  shortcut?: string;
  updatedAt: string;
  messages: StoredMessage[];
  folderName?: string;
  summary?: string;
  usage?: ConversationUsage;
};

export type TokenUsageMetrics = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
};

export type LlmCallUsage = {
  id: string;
  model: string;
  purpose: string;
  turn?: number;
  enableTools: boolean;
  inputMessageCount: number;
  selectedToolCount: number;
  createdAt: string;
  usage: TokenUsageMetrics;
};

export type ConversationUsage = {
  calls: LlmCallUsage[];
  totals: TokenUsageMetrics;
  updatedAt: string;
};

export type Project = {
  id: string;
  name: string;
  rootPath?: string;
  conversations: string[];
};

export type ProjectTreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: ProjectTreeNode[];
};

export type Skill = {
  id: string;
  title: string;
  description: string;
  accent: string;
  connected: boolean;
  installed: boolean;
  npmPackage?: string;
  source?: "builtin" | "user" | "discovered";
  categories?: string[];
  keywords?: string[];
  toolNames?: string[];
  instructions?: string;
  manifestPath?: string;
  lastLoadedAt?: string;
};

export type Automation = {
  id: string;
  title: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "never" | "running" | "success" | "error";
  lastResult?: string;
  lastError?: string;
  lastDocumentAttachmentId?: string;
  lastDocumentName?: string;
  runCount?: number;
  conversationId?: string;
  unreadCount?: number;
  runs?: AutomationRun[];
};

export type AutomationRun = {
  id: string;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "error";
  result?: string;
  error?: string;
  documentAttachmentId?: string;
  documentName?: string;
  unread?: boolean;
};

export type GoalTaskStatus = "planned" | "queued" | "running" | "completed" | "failed" | "interrupted";

export type GoalTask = {
  id: string;
  title: string;
  instruction: string;
  status: GoalTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  runCount: number;
  schedule?: string;
  nextRunAt?: string;
  fileTrigger?: { path: string; signature: string };
  githubReleaseTrigger?: {
    repo: string;
    seenIds: number[];
    etag?: string;
    nextCheckAt: string;
    lastCheckedAt?: string;
    lastError?: string;
  };
  calendarEventTrigger?: {
    since: string;
    seenVersions: string[];
    nextCheckAt: string;
    lastCheckedAt?: string;
    lastError?: string;
  };
  triggerContext?: string;
  sourceSuggestionId?: string;
  result?: string;
  error?: string;
  checkpoint?: {
    attemptId: string;
    messageId: string;
    phase: "planning" | "tool_started" | "finished";
    updatedAt: string;
    firstToolName?: string;
    lastToolName?: string;
    toolCount?: number;
    completedToolCount?: number;
    lastToolCallId?: string;
    lastToolOutcome?: "succeeded" | "failed" | "unknown";
  };
};

export type GoalSuggestion = {
  id: string;
  title: string;
  instruction: string;
  reason: string;
  status: "pending" | "accepted" | "dismissed";
  taskId?: string;
};

export type GoalReview = {
  id: string;
  taskId: string;
  runCount: number;
  summary: string;
  suggestions: GoalSuggestion[];
  createdAt: string;
};

export type GoalActivity = {
  id: string;
  taskId?: string;
  kind: "created" | "planned" | "queued" | "started" | "step" | "completed" | "failed" | "interrupted" | "review";
  text: string;
  createdAt: string;
};

export type GoalArtifactVersion = {
  revision: number;
  title: string;
  content: string;
  updatedAt: string;
  updatedBy: "user" | "agent";
  restoredFromRevision?: number;
};

export type GoalArtifact = GoalArtifactVersion & {
  id: string;
  createdAt: string;
  history?: GoalArtifactVersion[];
};

export type GoalFileVersion = {
  revision: number;
  title: string;
  size: number;
  taskId: string;
  toolName: string;
  updatedAt: string;
  snapshotSha256: string;
};

export type GoalFile = {
  id: string;
  title: string;
  path: string;
  kind: "image" | "file" | "code" | "presentation" | "table";
  size: number;
  taskId: string;
  toolName: string;
  createdAt: string;
  updatedAt: string;
  revision?: number;
  snapshotSha256?: string;
  history?: GoalFileVersion[];
};

export type Goal = {
  id: string;
  projectId: string;
  conversationId: string;
  title: string;
  description: string;
  status: "active" | "paused" | "completed";
  createdAt: string;
  updatedAt: string;
  planRevision?: number;
  tasks: GoalTask[];
  activity: GoalActivity[];
  reviews?: GoalReview[];
  artifacts?: GoalArtifact[];
  files?: GoalFile[];
};

export type Attachment = {
  id: string;
  conversationId: string;
  originalName: string;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  kind: "image" | "text" | "file";
  source?: "upload" | "artifact";
  createdAt: string;
  derivedFrom?: string;
};

export type PublicAttachment = Omit<Attachment, "path" | "fileName"> & {
  url: string;
};

export type Store = {
  settings?: ApiConfig;
  attention?: AttentionState;
  projects: Project[];
  conversations: Conversation[];
  skills: Skill[];
  automations: Automation[];
  goals?: Goal[];
  approvals?: Approval[];
  memories?: MemoryFact[];
  memoryCandidates?: MemoryCandidate[];
  attachments?: Attachment[];
};

export type AttentionState = { mode: "off" | "important" | "all"; readIds: string[] };

export type AttentionItem = {
  id: string;
  kind: "approval" | "goal" | "review" | "automation";
  priority: "important" | "normal";
  title: string;
  summary: string;
  createdAt: string;
  read: boolean;
  goalId?: string;
  automationId?: string;
  approvalId?: string;
};

export type ChatCompletionResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: ToolCall[];
    };
  }>;
  usage?: unknown;
  error?: { message?: string };
};

export type AgentResult = {
  finalMessage: Message;
  toolCalls: Array<{ id: string; name: string; args: string; result: string; trace?: ToolTrace }>;
  turns: number;
};

export type AgentRunOptions = {
  deliveryMode?: DeliveryMode;
  goalId?: string;
  authorizeTool?: (input: { toolName: string; riskLevel: string; args: Record<string, unknown>; toolCallId?: string; signal?: AbortSignal }) => Promise<boolean>;
  beforeToolExecute?: (input: { toolName: string; riskLevel: string; args: Record<string, unknown> }) => Promise<void>;
  afterToolExecute?: (input: { toolName: string; riskLevel: string; args: Record<string, unknown>; toolCallId: string; result: { ok: boolean; summary?: string; artifacts?: Array<{ title: string; path?: string; kind?: "image" | "file" | "code" | "presentation" | "table" }> } }) => Promise<void>;
};

export type Approval = {
  id: string;
  goalId?: string;
  taskId?: string;
  conversationId?: string;
  automationId?: string;
  toolName: string;
  riskLevel: string;
  summary: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  createdAt: string;
  decidedAt?: string;
  decisionSource?: "automatic" | "user";
  toolCallId?: string;
  executionStatus?: "succeeded" | "failed" | "interrupted";
  resultSummary?: string;
  executedAt?: string;
};

export type MemoryFact = {
  id: string;
  content: string;
  scope: "personal" | "goal";
  useMode?: "relevant" | "always" | "private";
  goalId?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  sourceQuote?: string;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
};

export type MemoryCandidate = {
  id: string;
  content: string;
  sourceConversationId: string;
  sourceMessageId: string;
  sourceQuote: string;
  confidence: number;
  status: "pending" | "accepted" | "dismissed";
  createdAt: string;
  decidedAt?: string;
  memoryId?: string;
};

export type AgentEvent =
  | { type: "step"; turn: number; message: string }
  | { type: "task_spec"; pipelineId: string; spec: TaskSpec; skillBundles: SkillContextBundle[] }
  | {
      type: "team_pipeline_start";
      pipelineId: string;
      template: PipelineTemplate;
      stages: Array<{
        name: string;
        parallel: boolean;
        agents: Array<{ role: string; toolCount: number }>;
      }>;
    }
  | { type: "sub_agent_start"; pipelineId: string; stageIndex: number; agentRole: string; agentId: string }
  | { type: "sub_agent_step"; pipelineId: string; stageIndex: number; agentRole: string; turn: number; message: string }
  | { type: "sub_agent_tool_call"; pipelineId: string; stageIndex: number; agentRole: string; toolName: string; args: string }
  | { type: "sub_agent_tool_result"; pipelineId: string; stageIndex: number; agentRole: string; result: string }
  | { type: "sub_agent_done"; pipelineId: string; stageIndex: number; agentRole: string; summary: string }
  | { type: "stage_done"; pipelineId: string; stageIndex: number }
  | { type: "review_verdict"; pipelineId: string; iteration: number; verdict: ReviewVerdict }
  | { type: "repair_iteration_start"; pipelineId: string; iteration: number; roles: string[] }
  | { type: "assistant_tool_call"; turn: number; message: Message }
  | { type: "tool_result"; turn: number; message: ToolMessage }
  | { type: "usage"; turn: number; call: LlmCallUsage; totals: TokenUsageMetrics }
  | {
      type: "team_final";
      pipelineId: string;
      pipeline: PipelineDefinition;
      finalMessage: Message;
      subAgentResults: unknown[];
    }
  | { type: "final"; turn: number; message: Message; conversation: Conversation; toolCalls: AgentResult["toolCalls"]; usage?: ConversationUsage }
  | { type: "error"; error: string };
