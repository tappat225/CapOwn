// SPDX-License-Identifier: Apache-2.0

// --------------------------------------------------------------------------
// Plugin manifest (local Worker configuration)
// --------------------------------------------------------------------------

export interface PluginPermissions {
  network: "none" | "local" | "all";
  read_roots: string[];
  write_roots: string[];
}

export interface PluginLimits {
  startup_timeout_seconds: number;
  call_timeout_seconds: number;
  max_argument_bytes: number;
  max_output_bytes: number;
  max_concurrency: number;
}

export interface PluginManifest {
  schema_version: number;
  plugin_id: string;
  version: string;
  display_name?: string;
  description?: string;
  kind: string;
  transport: string;
  enabled: boolean;
  command: string[];
  env?: Record<string, string>;
  permissions?: PluginPermissions;
  limits?: PluginLimits;
}

// --------------------------------------------------------------------------
// Plugin runtime types
// --------------------------------------------------------------------------

export type PluginStatus = "starting" | "running" | "stopped" | "error" | "disabled";

export interface PluginToolInfo {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface PluginInfo {
  plugin_id: string;
  version: string;
  kind: string;
  transport: string;
  enabled: boolean;
  status: PluginStatus;
  tools: PluginToolInfo[];
  error: string;
}

// --------------------------------------------------------------------------
// MCP JSON-RPC types
// --------------------------------------------------------------------------

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: unknown;
  }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown> | unknown[];
}

// --------------------------------------------------------------------------
// Result content blocks (protocol v1.5)
// --------------------------------------------------------------------------

export interface ContentBlock {
  type: "text" | "json";
  text?: string;
  value?: unknown;
}

export interface PluginCallResult {
  is_error: boolean;
  content: ContentBlock[];
  structured_content: unknown;
}
