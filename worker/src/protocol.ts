// SPDX-License-Identifier: Apache-2.0
/** TypeScript types matching the CapOwn Master v1 protocol models. */

// --------------------------------------------------------------------------
// Registration
// --------------------------------------------------------------------------

export interface WorkerRegistrationRequest {
  registration_token: string;
  worker_name: string;
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
}

// --------------------------------------------------------------------------
// Worker info (read back from Master)
// --------------------------------------------------------------------------

export interface WorkerInfo {
  worker_id: string;
  worker_name: string;
  hostname: string;
  os: string;
  mode: string;
  capabilities: string[];
  workspace: string;
  status: "online" | "offline";
  last_heartbeat: string | null;
  registered_at: string | null;
}

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

// --------------------------------------------------------------------------
// SSE event
// --------------------------------------------------------------------------

export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}
