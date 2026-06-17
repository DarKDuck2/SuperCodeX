import type { ToolCall, ToolTrace } from "../tools/types.js";

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
  projects: Project[];
  conversations: Conversation[];
  skills: Skill[];
  automations: Automation[];
  attachments?: Attachment[];
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

export type AgentEvent =
  | { type: "step"; turn: number; message: string }
  | { type: "assistant_tool_call"; turn: number; message: Message }
  | { type: "tool_result"; turn: number; message: ToolMessage }
  | { type: "usage"; turn: number; call: LlmCallUsage; totals: TokenUsageMetrics }
  | { type: "final"; turn: number; message: Message; conversation: Conversation; toolCalls: AgentResult["toolCalls"]; usage?: ConversationUsage }
  | { type: "error"; error: string };
