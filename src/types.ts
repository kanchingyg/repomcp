export type JsonSchemaProperty = {
  type?: string;
  description?: string;
  [key: string]: unknown;
};

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type RepomcpTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  mutates?: boolean;
  annotations?: ToolAnnotations;
};

export type InitOptions = {
  repoRoot: string;
  serverName: string;
  command: string;
  args: string[];
  tools: RepomcpTool[];
  embedPort?: number;
};

export type DirtyToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ChatMessage = {
  role: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: unknown[];
};

export type ReasoningState = {
  inToolLoop: boolean;
  lastUserTurnIndex: number;
};

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
