export type ToolRiskLevel = "read" | "write" | "network" | "external" | "shell" | "destructive";

export type ToolPermission =
  | "workspace:read"
  | "workspace:write"
  | "network:fetch"
  | "external:webbridge"
  | "shell:run"
  | "attachments:read"
  | "attachments:write";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolContext = {
  workspacePath: string;
  outputPath: string;
  attachments: Array<{
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
  }>;
};

export type ToolResult = {
  ok: boolean;
  summary: string;
  data?: unknown;
  artifacts?: Array<{
    id?: string;
    title: string;
    href?: string;
    path?: string;
    kind?: "image" | "file" | "code" | "presentation" | "table";
  }>;
  stdout?: string;
  stderr?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type ToolHandlerResult = string | ToolResult;

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<ToolHandlerResult>;

export type ToolMetadata = {
  riskLevel: ToolRiskLevel;
  permissions: ToolPermission[];
  timeoutMs?: number;
  producesArtifacts?: boolean;
  skillIds?: string[];
  categories?: string[];
  keywords?: string[];
};

export type RegisteredTool = {
  definition: ToolDefinition;
  metadata: ToolMetadata;
  handler: ToolHandler;
};

export type ToolPolicyDecision =
  | { action: "allow"; reason?: string }
  | { action: "deny"; reason: string };

export type ToolTrace = {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  policy: ToolPolicyDecision;
  startedAt: string;
  finishedAt?: string;
  result?: ToolResult;
};
