// SPDX-License-Identifier: Apache-2.0
/** TypeScript types matching the CapOwn Master v1 protocol models. */

// --------------------------------------------------------------------------
// Registration
// --------------------------------------------------------------------------

export interface WorkerRegistrationRequest {
  registration_token: string;
  public_key: string;
  hostname: string;
  os: string;
  mode: string;
  capabilities: string[];
  workspace: string;
}
export interface WorkerRegistrationResponse {
  worker_id: string;
  worker_name: string;
}

export interface CreatedRegistrationToken {
  token_id: string;
  registration_token: string;
  token_prefix: string;
  scope: string;
  expires_at: string;
  max_uses: number;
  label: string;
  created_at: string;
  registration_url?: string;
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

export interface WorkerAuthChallengeRequest {
  worker_id: string;
}

export interface WorkerAuthChallengeResponse {
  nonce: string;
  expires_at: string;
}

export interface WorkerAuthVerifyRequest {
  worker_id: string;
  nonce: string;
  signature: string;
}

export interface WorkerAuthVerifyResponse {
  status: string;
  session_token: string;
}

// --------------------------------------------------------------------------
// Runtime
// --------------------------------------------------------------------------

export interface WorkerReconnectRequest {
  hostname: string;
  os: string;
  mode: string;
  capabilities: string[];
  workspace: string;
  plugins: PluginInfoItem[];
}

// --------------------------------------------------------------------------
// Worker info (read back from Master)
// --------------------------------------------------------------------------

export interface WorkerInfo {
  worker_id: string;
  worker_name: string;
  owner_user_id: string;
  owner_username: string;
  hostname: string;
  os: string;
  mode: string;
  capabilities: string[];
  workspace: string;
  status: "online" | "offline";
  last_heartbeat: string | null;
  registered_at: string | null;
  plugins: PluginInfoItem[];
}

// --------------------------------------------------------------------------
// Plugin types
// --------------------------------------------------------------------------

export interface PluginToolInfoItem {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface PluginInfoItem {
  plugin_id: string;
  version: string;
  kind: string;
  transport: string;
  enabled: boolean;
  status: PluginStatus;
  tools: PluginToolInfoItem[];
  error: string;
}

export type PluginStatus = "starting" | "running" | "stopped" | "error" | "disabled";

// --------------------------------------------------------------------------
// Task / job types (v1.5)
// --------------------------------------------------------------------------

export type JobType = "task" | "cancel";

export interface WorkerJob {
  job_type: JobType;
  delivery_id: string;
  task_id: string;
  task_type?: string;
  params?: Record<string, unknown>;
  timeout_seconds?: number;
}

export interface WorkerJobsResponse {
  jobs: WorkerJob[];
}

export interface PluginCallParams {
  plugin_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface PluginSetEnabledParams {
  plugin_id: string;
  enabled: boolean;
}

export interface PluginInstallParams {
  plugin_id: string;
  version: string;
  package_url: string;
  sha256: string;
  manifest: Record<string, unknown>;
}

export interface PluginUninstallParams {
  plugin_id: string;
}

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

export interface TaskResultReport {
  task_id: string;
  delivery_id: string;
  worker_id: string;
  status: TaskResultStatus;
  result?: PluginCallResult;
  error?: {
    code: string;
    message: string;
    details: unknown;
  };
  started_at?: string;
  completed_at?: string;
  truncated: boolean;
}

export type TaskResultStatus = "running" | "completed" | "failed" | "timeout" | "canceled";

// --------------------------------------------------------------------------
// API error envelope
// --------------------------------------------------------------------------

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: unknown;
  };
}
