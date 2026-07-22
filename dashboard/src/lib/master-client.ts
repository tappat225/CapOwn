import { z } from "zod";
import { MINIMUM_PROTOCOL_VERSION } from "../generated/version";

/** Browser client for the CapOwn Master v1 API. */

export class MasterClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly errorCode?: string,
  ) {
    super(message);
    this.name = "MasterClientError";
  }
}

export const CAPOWN_MASTER_PRODUCT = "capown-master";
export const MINIMUM_PASSWORD_LENGTH = 6;

type ParsedSemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemVer(value: string): ParsedSemVer | null {
  const match = value.match(SEMVER_RE);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] !== right[field]) {
      return left[field] > right[field] ? 1 : -1;
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }
  if (left.prerelease.length === 0) {
    return 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      if (leftIdentifier.length !== rightIdentifier.length) {
        return leftIdentifier.length > rightIdentifier.length ? 1 : -1;
      }
      return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

function meetsMinimumProtocolVersion(actual: string): boolean {
  const parsedActual = parseSemVer(actual);
  const parsedMinimum = parseSemVer(MINIMUM_PROTOCOL_VERSION);
  return (
    parsedActual !== null &&
    parsedMinimum !== null &&
    compareSemVer(parsedActual, parsedMinimum) >= 0
  );
}

const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().nullable(),
  }),
});

const roleSchema = z.enum(["user", "admin"]);

const userSchema = z.object({
  user_id: z.string().min(1),
  username: z.string().min(1),
  role: roleSchema,
  status: z.string().optional(),
  created_at: z.string().optional(),
  disabled_at: z.string().nullable().optional(),
});

const loginResponseSchema = z.object({
  access_token: z.string().startsWith("cown_web_"),
  token_type: z.literal("bearer"),
  expires_at: z.string(),
  user: userSchema,
});

const metaResponseSchema = z.object({
  product: z.literal(CAPOWN_MASTER_PRODUCT),
  version: z.string(),
  protocol_version: z.string().min(1),
  initialized: z.boolean(),
  capabilities: z.array(z.string()),
});

const pluginToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  input_schema: z.record(z.unknown()),
});

const pluginInfoSchema = z.object({
  plugin_id: z.string().min(1),
  version: z.string(),
  kind: z.string(),
  transport: z.string(),
  enabled: z.boolean(),
  status: z.enum(["starting", "running", "stopped", "error", "disabled"]),
  tools: z.array(pluginToolSchema),
  error: z.string(),
});

const workerSchema = z.object({
  worker_id: z.string(),
  worker_name: z.string(),
  owner_user_id: z.string().min(1),
  owner_username: z.string().min(1),
  hostname: z.string(),
  os: z.string(),
  mode: z.string(),
  capabilities: z.array(z.string()),
  workspace: z.string(),
  status: z.string(),
  last_heartbeat: z.string().nullable(),
  registered_at: z.string().nullable(),
  previous_worker_name: z.string().nullable(),
  renamed_at: z.string().nullable(),
  plugins: z.array(pluginInfoSchema).default([]),
});

const taskSchema = z.object({
  task_id: z.string().min(1),
  target_worker: z.string().min(1),
  task_type: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  status: z.enum([
    "pending",
    "running",
    "completed",
    "failed",
    "timeout",
    "canceled",
  ]),
  timeout_seconds: z.number().int().positive(),
  created_at: z.string(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  truncated: z.boolean(),
});

const clientTokenSchema = z.object({
  token_id: z.string().min(1),
  token_prefix: z.string().min(1),
  label: z.string(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  // Newer Masters include the source address alongside the last-use time.
  // Keep it optional so older protocol-compatible Masters remain usable.
  last_used_ip: z.string().nullable().optional(),
  revoked_at: z.string().nullable().optional(),
  status: z.string(),
});

const createdClientTokenSchema = z.object({
  token_id: z.string().min(1),
  token: z.string().min(1),
  token_type: z.literal("client"),
  token_prefix: z.string().min(1),
  label: z.string(),
  created_at: z.string(),
});

const workerRegistrationSchema = z.object({
  token_id: z.string().min(1),
  token_prefix: z.string().min(1),
  scope: z.literal("worker"),
  expires_at: z.string(),
  max_uses: z.number().int().positive(),
  used_count: z.number().int().nonnegative().optional(),
  revoked_at: z.string().nullable().optional(),
  created_at: z.string(),
  label: z.string(),
});

const createdWorkerRegistrationSchema = workerRegistrationSchema.extend({
  registration_token: z.string().startsWith("cown_register_"),
  registration_url: z.string().min(1).optional(),
});

const invitationSchema = z.object({
  invitation_id: z.string().min(1),
  code_prefix: z.string().min(1),
  label: z.string(),
  created_by: z.string().min(1),
  created_at: z.string(),
  expires_at: z.string(),
  used_at: z.string().nullable(),
  used_by: z.string().nullable(),
  revoked_at: z.string().nullable(),
  status: z.enum(["active", "used", "expired", "revoked"]),
});

const createdInvitationSchema = invitationSchema.extend({
  invitation_code: z.string().startsWith("cown_invite_"),
});

function collectionSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
  });
}

function parseMasterDate(value: string): Date {
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value);
  return new Date(hasTimezone ? value : `${value}Z`);
}

export type MasterRole = z.infer<typeof roleSchema>;
type MasterUserResponse = z.infer<typeof userSchema>;
export type MasterMeta = z.infer<typeof metaResponseSchema>;
export type WorkerInfo = z.infer<typeof workerSchema>;
export type PluginInfo = z.infer<typeof pluginInfoSchema>;
export type MasterTask = z.infer<typeof taskSchema>;
export type ClientTokenInfo = z.infer<typeof clientTokenSchema>;
export type CreatedClientToken = z.infer<typeof createdClientTokenSchema>;
export type WorkerRegistrationInfo = z.infer<typeof workerRegistrationSchema>;
export type CreatedWorkerRegistration = z.infer<
  typeof createdWorkerRegistrationSchema
>;
export type InvitationInfo = z.infer<typeof invitationSchema>;
export type CreatedInvitation = z.infer<typeof createdInvitationSchema>;

export interface CatalogVersion {
  version: string;
  published_at: string;
  package_url: string;
  sha256: string;
  requires: Record<string, string>;
  manifest: Record<string, unknown>;
}

export interface CatalogEntry {
  plugin_id: string;
  display_name: string;
  description: string;
  icon: string;
  tags: string[];
  publisher: string;
  source: "bundled" | "registry";
  versions: CatalogVersion[];
}

export interface PluginCatalog {
  schema_version: number;
  updated_at: string;
  plugins: CatalogEntry[];
}

export interface MasterUser {
  userId: string;
  username: string;
  role: MasterRole;
  status?: string;
  createdAt?: string;
  disabledAt?: string | null;
}

const storedUserSchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1),
  role: roleSchema,
  status: z.string().optional(),
  createdAt: z.string().optional(),
  disabledAt: z.string().nullable().optional(),
});

export interface MasterLoginResult {
  accessToken: string;
  tokenType: "bearer";
  expiresAt: Date;
  user: MasterUser;
}

export interface StoredMasterSession {
  masterOrigin: string;
  accessToken: string;
  expiresAt: string;
  user: MasterUser;
}

export interface MasterSseEvent {
  event: string;
  data: string;
  id?: string;
}

export const MASTER_ORIGIN_STORAGE_KEY = "capown_master_origin";
const MASTER_TOKEN_STORAGE_KEY = "capown_web_token";
const MASTER_SESSION_STORAGE_KEY = "capown_web_session";

function canUseBrowserStorage(): boolean {
  return typeof window !== "undefined" && typeof sessionStorage !== "undefined";
}

export function getStoredMasterOrigin(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(MASTER_ORIGIN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveMasterOrigin(origin: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MASTER_ORIGIN_STORAGE_KEY, origin);
  } catch {
    // Storage may be disabled by the browser; the current session still works.
  }
}

export function saveMasterSession(
  masterOrigin: string,
  login: MasterLoginResult,
): StoredMasterSession | null {
  const session: StoredMasterSession = {
    masterOrigin,
    accessToken: login.accessToken,
    expiresAt: login.expiresAt.toISOString(),
    user: login.user,
  };

  if (!canUseBrowserStorage()) return session;

  try {
    sessionStorage.setItem(MASTER_TOKEN_STORAGE_KEY, session.accessToken);
    sessionStorage.setItem(
      MASTER_SESSION_STORAGE_KEY,
      JSON.stringify({
        masterOrigin: session.masterOrigin,
        expiresAt: session.expiresAt,
        user: session.user,
      }),
    );
  } catch {
    // Return the in-memory value so callers can continue this page lifetime.
  }

  return session;
}

export function loadMasterSession(): StoredMasterSession | null {
  if (!canUseBrowserStorage()) return null;

  try {
    const raw = sessionStorage.getItem(MASTER_SESSION_STORAGE_KEY);
    const accessToken = sessionStorage.getItem(MASTER_TOKEN_STORAGE_KEY);
    if (!raw || !accessToken) return null;

    const parsed = z
      .object({
        masterOrigin: z.string(),
        expiresAt: z.string(),
        user: storedUserSchema,
      })
      .safeParse(JSON.parse(raw));
    const expiresAt = parsed.success
      ? new Date(parsed.data.expiresAt).getTime()
      : Number.NaN;
    if (
      !parsed.success ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      clearMasterSession();
      return null;
    }

    return { ...parsed.data, accessToken };
  } catch {
    clearMasterSession();
    return null;
  }
}

export function clearMasterSession(): void {
  if (!canUseBrowserStorage()) return;
  try {
    sessionStorage.removeItem(MASTER_TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(MASTER_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function sanitizeError(error: unknown): string {
  if (error instanceof MasterClientError) return error.message;
  return error instanceof Error ? error.message : "Unknown Master client error";
}

export function isSessionInvalidError(error: unknown): boolean {
  return (
    error instanceof MasterClientError &&
    (error.statusCode === 401 ||
      (error.statusCode === 403 && error.errorCode === "user_disabled"))
  );
}

export function normalizeMasterOrigin(origin: string): string {
  const trimmed = origin.trim();
  if (!trimmed) throw new Error("Master origin is required");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid Master origin");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Master origin must use HTTP or HTTPS protocol");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Master origin must not include credentials");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("Master origin must not include a path");
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      "Master origin must not include query parameters or fragment",
    );
  }

  return parsed.origin;
}

export class MasterClient {
  private readonly origin: string;
  private readonly timeoutMs: number;

  constructor(params: { origin: string; timeoutMs?: number }) {
    this.origin = normalizeMasterOrigin(params.origin);
    this.timeoutMs = params.timeoutMs ?? 10_000;
  }

  get masterOrigin(): string {
    return this.origin;
  }

  private apiUrl(path: string): string {
    return `${this.origin}/v1${path}`;
  }

  private async request<T>(
    path: string,
    options: RequestInit & { expectedStatus?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const { expectedStatus = 200, ...requestOptions } = options;
      const response = await fetch(this.apiUrl(path), {
        ...requestOptions,
        redirect: "error",
        signal: controller.signal,
      });

      if (response.status !== expectedStatus) {
        await this.readError(response);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof MasterClientError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new MasterClientError(
          `Master request timed out after ${this.timeoutMs}ms`,
          504,
        );
      }
      if (error instanceof TypeError) {
        throw new MasterClientError(
          `Master is unreachable or does not allow this Dashboard origin`,
          502,
        );
      }
      throw new MasterClientError(
        error instanceof Error ? error.message : "Unknown Master client error",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestNoContent(
    path: string,
    accessToken: string,
    options: RequestInit & { expectedStatus?: number } = {},
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const { expectedStatus = 204, ...requestOptions } = options;
      const response = await fetch(this.apiUrl(path), {
        ...requestOptions,
        redirect: "error",
        headers: {
          ...requestOptions.headers,
          Authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      });
      if (response.status !== expectedStatus) await this.readError(response);
    } catch (error) {
      if (error instanceof MasterClientError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new MasterClientError(
          `Master request timed out after ${this.timeoutMs}ms`,
          504,
        );
      }
      if (error instanceof TypeError) {
        throw new MasterClientError(
          "Master is unreachable or does not allow this Dashboard origin",
          502,
        );
      }
      throw new MasterClientError(
        error instanceof Error ? error.message : "Unknown Master client error",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readError(response: Response): Promise<never> {
    let message = `Master API returned ${response.status}`;
    let code: string | undefined;
    try {
      const parsed = apiErrorSchema.safeParse(await response.json());
      if (parsed.success) {
        message = parsed.data.error.message;
        code = parsed.data.error.code;
      }
    } catch {
      // Keep the status-only message.
    }
    throw new MasterClientError(message, response.status, code);
  }

  private authHeaders(accessToken: string): Record<string, string> {
    return { Authorization: `Bearer ${accessToken}` };
  }

  async getMeta(): Promise<MasterMeta> {
    const data = await this.request<unknown>("/meta");
    const parsed = metaResponseSchema.safeParse(data);
    if (!parsed.success) {
      const raw = data as Record<string, unknown>;
      if (raw?.product !== CAPOWN_MASTER_PRODUCT) {
        throw new MasterClientError(
          "The selected service is not a CapOwn Master",
        );
      }
      throw new MasterClientError("Unrecognized Master metadata");
    }
    if (!meetsMinimumProtocolVersion(parsed.data.protocol_version)) {
      throw new MasterClientError(
        `Unsupported Master protocol; expected at least ${MINIMUM_PROTOCOL_VERSION}`,
      );
    }
    return parsed.data;
  }

  async registerFirstUser(
    username: string,
    password: string,
  ): Promise<MasterLoginResult> {
    return this.registerUser(username, password);
  }

  async registerUser(
    username: string,
    password: string,
    invitationCode?: string,
  ): Promise<MasterLoginResult> {
    return this.parseLoginResponse(
      await this.request<unknown>("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          ...(invitationCode ? { invitation_code: invitationCode } : {}),
        }),
        expectedStatus: 201,
      }),
    );
  }

  async login(username: string, password: string): Promise<MasterLoginResult> {
    return this.parseLoginResponse(
      await this.request<unknown>("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }),
    );
  }

  private parseLoginResponse(data: unknown): MasterLoginResult {
    const parsed = loginResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized login response",
      );
    }
    return {
      accessToken: parsed.data.access_token,
      tokenType: parsed.data.token_type,
      expiresAt: parseMasterDate(parsed.data.expires_at),
      user: mapUser(parsed.data.user),
    };
  }

  async getCurrentUser(accessToken: string): Promise<MasterUser> {
    const data = await this.request<unknown>("/me", {
      headers: this.authHeaders(accessToken),
    });
    const parsed = userSchema.safeParse(data);
    if (!parsed.success)
      throw new MasterClientError("Unrecognized Master user response");
    return mapUser(parsed.data);
  }

  async logout(accessToken: string): Promise<void> {
    try {
      await this.request<Record<string, unknown>>("/auth/logout", {
        method: "POST",
        headers: this.authHeaders(accessToken),
      });
    } catch {
      // Best-effort: local session state is cleared by the caller.
    }
  }

  async listWorkers(accessToken: string): Promise<WorkerInfo[]> {
    const data = await this.request<unknown>("/workers", {
      headers: this.authHeaders(accessToken),
    });
    const parsed = collectionSchema(workerSchema).safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized worker list response",
      );
    }
    return parsed.data.items;
  }

  async revokeWorker(accessToken: string, workerId: string): Promise<void> {
    await this.requestNoContent(
      `/workers/${encodeURIComponent(workerId)}`,
      accessToken,
      { method: "DELETE" },
    );
  }

  async createWorkerRegistration(
    accessToken: string,
    label: string,
  ): Promise<CreatedWorkerRegistration> {
    const data = await this.request<unknown>("/worker-registrations", {
      method: "POST",
      headers: {
        ...this.authHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label }),
      expectedStatus: 201,
    });
    const parsed = createdWorkerRegistrationSchema.safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized Worker registration response",
      );
    }
    return parsed.data;
  }

  async listUsers(accessToken: string): Promise<MasterUser[]> {
    const data = await this.request<unknown>("/admin/users", {
      headers: this.authHeaders(accessToken),
    });
    const parsed = z.array(userSchema).safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized user list response",
      );
    }
    return parsed.data.map(mapUser);
  }

  async setUserStatus(
    accessToken: string,
    username: string,
    status: "active" | "disabled",
  ): Promise<MasterUser> {
    const data = await this.request<unknown>(
      `/admin/users/${encodeURIComponent(username)}`,
      {
        method: "PATCH",
        headers: {
          ...this.authHeaders(accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status }),
      },
    );
    const parsed = userSchema.safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized user response",
      );
    }
    return mapUser(parsed.data);
  }

  async deleteUser(accessToken: string, username: string): Promise<void> {
    await this.requestNoContent(
      `/admin/users/${encodeURIComponent(username)}`,
      accessToken,
      { method: "DELETE" },
    );
  }

  async listInvitations(accessToken: string): Promise<InvitationInfo[]> {
    const data = await this.request<unknown>("/admin/invitations", {
      headers: this.authHeaders(accessToken),
    });
    const parsed = z.array(invitationSchema).safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized invitation list response",
      );
    }
    return parsed.data;
  }

  async createInvitation(
    accessToken: string,
    label: string,
  ): Promise<CreatedInvitation> {
    const data = await this.request<unknown>("/admin/invitations", {
      method: "POST",
      headers: {
        ...this.authHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label }),
      expectedStatus: 201,
    });
    const parsed = createdInvitationSchema.safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized invitation response",
      );
    }
    return parsed.data;
  }

  async revokeInvitation(
    accessToken: string,
    invitationId: string,
  ): Promise<void> {
    await this.requestNoContent(
      `/admin/invitations/${encodeURIComponent(invitationId)}`,
      accessToken,
      { method: "DELETE" },
    );
  }

  async listWorkerPlugins(
    accessToken: string,
    workerId: string,
  ): Promise<PluginInfo[]> {
    const data = await this.request<unknown>(
      `/workers/${encodeURIComponent(workerId)}/plugins`,
      { headers: this.authHeaders(accessToken) },
    );
    const parsed = z.array(pluginInfoSchema).safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized plugin list response",
      );
    }
    return parsed.data;
  }

  async setWorkerPluginEnabled(
    accessToken: string,
    workerId: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<MasterTask> {
    const data = await this.request<unknown>(
      `/workers/${encodeURIComponent(workerId)}/plugins/${encodeURIComponent(pluginId)}`,
      {
        method: "PATCH",
        headers: {
          ...this.authHeaders(accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled }),
        expectedStatus: 202,
      },
    );
    const parsed = taskSchema.safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized task response",
      );
    }
    return parsed.data;
  }

  async getTask(accessToken: string, taskId: string): Promise<MasterTask> {
    const data = await this.request<unknown>(
      `/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: this.authHeaders(accessToken),
      },
    );
    const parsed = taskSchema.safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized task response",
      );
    }
    return parsed.data;
  }

  async getPluginCatalog(accessToken: string): Promise<PluginCatalog> {
    const data = await this.request<unknown>("/plugins/catalog", {
      headers: this.authHeaders(accessToken),
    });
    return data as PluginCatalog;
  }

  async installPluginToWorker(
    accessToken: string,
    workerId: string,
    entry: CatalogEntry,
    version: CatalogVersion,
  ): Promise<MasterTask> {
    const data = await this.request<unknown>("/tasks", {
      method: "POST",
      headers: {
        ...this.authHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target_worker: workerId,
        payload: {
          task_type: "plugin_install",
          params: {
            plugin_id: entry.plugin_id,
            version: version.version,
            package_url: version.package_url,
            sha256: version.sha256,
            manifest: version.manifest,
          },
        },
        timeout_seconds: 300,
      }),
      expectedStatus: 202,
    });
    const parsed = taskSchema.safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized task response",
      );
    }
    return parsed.data;
  }

  async uninstallPluginFromWorker(
    accessToken: string,
    workerId: string,
    pluginId: string,
  ): Promise<MasterTask> {
    const data = await this.request<unknown>("/tasks", {
      method: "POST",
      headers: {
        ...this.authHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target_worker: workerId,
        payload: {
          task_type: "plugin_uninstall",
          params: { plugin_id: pluginId },
        },
        timeout_seconds: 60,
      }),
      expectedStatus: 202,
    });
    const parsed = taskSchema.safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized task response",
      );
    }
    return parsed.data;
  }

  async listClientTokens(accessToken: string): Promise<ClientTokenInfo[]> {
    const data = await this.request<unknown>("/tokens?type=client", {
      headers: this.authHeaders(accessToken),
    });
    const parsed = collectionSchema(clientTokenSchema).safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized token list response",
      );
    }
    return parsed.data.items;
  }

  async createClientToken(
    accessToken: string,
    label: string,
  ): Promise<CreatedClientToken> {
    const data = await this.request<unknown>("/tokens", {
      method: "POST",
      headers: {
        ...this.authHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "client", label }),
      expectedStatus: 201,
    });
    const parsed = createdClientTokenSchema.safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized client token response",
      );
    }
    return parsed.data;
  }

  async setClientTokenStatus(
    accessToken: string,
    tokenId: string,
    status: "active" | "disabled",
  ): Promise<ClientTokenInfo> {
    const data = await this.request<unknown>(
      `/tokens/${encodeURIComponent(tokenId)}`,
      {
        method: "PATCH",
        headers: {
          ...this.authHeaders(accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status }),
      },
    );
    const parsed = clientTokenSchema.safeParse(data);
    if (!parsed.success) {
      throw new MasterClientError(
        "Master returned an unrecognized client token response",
      );
    }
    return parsed.data;
  }

  async revokeClientToken(accessToken: string, tokenId: string): Promise<void> {
    await this.requestNoContent(
      `/tokens/${encodeURIComponent(tokenId)}`,
      accessToken,
      { method: "DELETE" },
    );
  }

  async openUserEventStream(
    accessToken: string,
    signal: AbortSignal,
    lastEventId?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.authHeaders(accessToken),
      Accept: "text/event-stream",
    };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;

    try {
      const response = await fetch(this.apiUrl("/events"), {
        headers,
        signal,
        redirect: "error",
      });
      if (!response.ok) await this.readError(response);
      if (!response.body)
        throw new MasterClientError("Master returned an empty event stream");
      return response;
    } catch (error) {
      if (error instanceof MasterClientError) throw error;
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      if (error instanceof TypeError) {
        throw new MasterClientError(
          "Master event stream is unreachable or CORS is not configured",
          502,
        );
      }
      throw error;
    }
  }
}

export async function consumeMasterEventStream(
  response: Response,
  onEvent: (event: MasterSseEvent) => void,
  signal: AbortSignal,
  idleTimeoutMs = 30_000,
): Promise<void> {
  if (!response.body) {
    throw new MasterClientError("Master returned an empty event stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const { done, value } = await readStreamChunk(
        reader,
        idleTimeoutMs,
        signal,
      );
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let boundary = findSseBoundary(buffer);
      while (boundary !== -1) {
        const separatorLength = buffer.startsWith("\r\n", boundary) ? 4 : 2;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separatorLength);
        dispatchSseBlock(block, onEvent);
        boundary = findSseBoundary(buffer);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The connection may already be closed by the browser.
    }
    reader.releaseLock();
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal: AbortSignal,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new MasterClientError(
          `Master event stream was silent for ${idleTimeoutMs}ms`,
          504,
        ),
      );
      void reader.cancel();
    }, idleTimeoutMs);
    abortHandler = () => {
      reject(new DOMException("Aborted", "AbortError"));
      void reader.cancel();
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    return await Promise.race([reader.read(), interrupted]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

function findSseBoundary(buffer: string) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1) return lf;
  if (lf === -1) return crlf;
  return Math.min(crlf, lf);
}

function dispatchSseBlock(
  block: string,
  onEvent: (event: MasterSseEvent) => void,
) {
  let eventName = "message";
  let eventId: string | undefined;
  const data: string[] = [];

  for (const line of block.replaceAll("\r\n", "\n").split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value =
      separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventName = value;
    else if (field === "id") eventId = value;
    else if (field === "data") data.push(value);
  }

  if (data.length > 0) {
    onEvent({ event: eventName, data: data.join("\n"), id: eventId });
  }
}

function mapUser(user: MasterUserResponse): MasterUser {
  return {
    userId: user.user_id,
    username: user.username,
    role: user.role,
    ...(user.status ? { status: user.status } : {}),
    ...(user.created_at ? { createdAt: user.created_at } : {}),
    ...(user.disabled_at !== undefined ? { disabledAt: user.disabled_at } : {}),
  };
}
