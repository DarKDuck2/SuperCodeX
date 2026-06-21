export type Role = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type Message = {
  id: string;
  role: Exclude<Role, "system" | "tool">;
  content: string;
  tool_calls?: ToolCall[];
  attachments?: Attachment[];
  createdAt?: string;
  status?: "thinking" | "done" | "error";
};

export type ToolMessage = {
  id: string;
  role: "tool";
  content: string;
  tool_call_id: string;
  toolName?: string;
  createdAt?: string;
};

export type StoredMessage = Message | ToolMessage;

export type ApiSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type AgentRunMode = "agent" | "team";

export type DeliveryMode = "fast" | "standard" | "strict";

export type Project = {
  id: string;
  name: string;
  rootPath?: string;
  conversations: ConversationSummary[];
};

export type ConversationSummary = {
  id: string;
  title: string;
  shortcut?: string;
  updatedAt?: string;
  messageCount?: number;
};

export type Skill = {
  id: string;
  title: string;
  description: string;
  accent: string;
  connected: boolean;
  installed?: boolean;
  source?: "builtin" | "user" | "discovered";
  categories?: string[];
  keywords?: string[];
  toolNames?: string[];
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

export type Automation = {
  id: string;
  title: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
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

export type AppState = {
  settings: ApiSettings & { configured?: boolean };
  projects: Project[];
  skills: Skill[];
  automations: Automation[];
};

export type ActiveView = "home" | "skills" | "automations" | "search" | "webbridge";

export type AutomationPreview = {
  title: string;
  schedule: string;
  prompt: string;
  nextRunAt?: string;
};

export type SearchResult = {
  id: string;
  title: string;
  projectId: string;
  type: string;
};

export type WebBridgeStatus = {
  running: boolean;
  extension_connected: boolean;
  port: number;
  version: string;
  extension_version?: string;
};

export type AgentStreamEvent =
  | { type: "step"; turn: number; message: string }
  | {
      type: "task_spec";
      pipelineId: string;
      spec: {
        id: string;
        complexity: string;
        domains: string[];
        goal: string;
        deliverables: string[];
        constraints: string[];
        requiredSkills: string[];
        acceptanceCriteria: string[];
        verificationPlan: string[];
        risks: string[];
        maxIterations: number;
      };
      skillBundles: Array<{ skillId: string; title: string }>;
    }
  | {
      type: "team_pipeline_start";
      pipelineId: string;
      template: string;
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
  | {
      type: "review_verdict";
      pipelineId: string;
      iteration: number;
      verdict: {
        passed: boolean;
        score: number;
        failedCriteria: string[];
        requiredFixes: string[];
        risks: string[];
        summary: string;
      };
    }
  | { type: "repair_iteration_start"; pipelineId: string; iteration: number; roles: string[] }
  | { type: "assistant_tool_call"; turn: number; message: Message }
  | { type: "tool_result"; turn: number; message: ToolMessage }
  | {
      type: "final";
      turn: number;
      message: Message;
      conversation: { messages: StoredMessage[] };
      toolCalls: unknown[];
    }
  | {
      type: "team_final";
      pipelineId: string;
      pipeline: unknown;
      finalMessage: Message;
      subAgentResults: unknown[];
    }
  | { type: "error"; error: string };

export type ProjectTreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: ProjectTreeNode[];
};

export type Attachment = {
  id: string;
  conversationId: string;
  originalName: string;
  mimeType: string;
  size: number;
  kind: "image" | "text" | "file";
  source?: "upload" | "artifact";
  createdAt: string;
  url: string;
  derivedFrom?: string;
};

export type Artifact = {
  id: string;
  title: string;
  description: string;
  href: string;
  kind: "image" | "file" | "code" | "presentation" | "table";
  filePath?: string;
};

export type ToolRound = {
  assistant?: Message;
  toolResults: ToolMessage[];
};

export type MessageDisplayItem =
  | { type: "message"; message: Message }
  | { type: "toolRound"; id: string; rounds: ToolRound[] };
