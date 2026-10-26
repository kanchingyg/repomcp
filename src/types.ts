/** Configuration and data shape for `JsonSchemaProperty` (json schema property). */
export type JsonSchemaProperty = {
  type?: string;
  description?: string;
  [key: string]: unknown;
};

/** Configuration and data shape for `JsonSchema` (json schema). */
export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

/** Configuration and data shape for `ToolAnnotations` (tool annotations). */
export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** Configuration and data shape for `RepomcpTool` (repomcp tool). */
export type RepomcpTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  mutates?: boolean;
  annotations?: ToolAnnotations;
};

/** Configuration and data shape for `InitOptions` (init options). */
export type InitOptions = {
  repoRoot: string;
  serverName: string;
  command: string;
  args: string[];
  tools: RepomcpTool[];
  embedPort?: number;
};

/** Configuration and data shape for `DirtyToolCall` (dirty tool call). */
export type DirtyToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

/** Configuration and data shape for `ChatMessage` (chat message). */
export type ChatMessage = {
  role: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: unknown[];
};

/** Configuration and data shape for `ReasoningState` (reasoning state). */
export type ReasoningState = {
  inToolLoop: boolean;
  lastUserTurnIndex: number;
};

/** Configuration and data shape for `ProviderId` (provider id). */
export type ProviderId =
  | "deepseek"
  | "dashscope"
  | "moonshot"
  | "zhipu"
  | "minimax"
  | "siliconflow"
  | "doubao"
  | "stepfun"
  | "yi"
  | "ollama"
  | "anthropic"
  | "openai"
  | "generic";
