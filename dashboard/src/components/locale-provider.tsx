"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "zh" | "en";

const en = {
  credentialsTitle: "Connection credentials",
  credentialsHint:
    "Create a temporary Worker registration link or a long-lived Client/MCP token.",
  workerRegistration: "Worker registration",
  workerRegistrationHint:
    "Generate a short-lived registration link to connect a new Worker.",
  workerLabel: "Worker label (optional)",
  createWorkerRegistration: "Register worker",
  creatingWorkerRegistration: "Creating Worker link...",
  workerRegistrationCreated: "Worker registration created",
  workerRegisterCommand: "Worker register command",
  workerRegisterCommandLocalHint:
    "This Master URL is a local address. Workers outside this machine must use a reachable public or reverse-proxy URL instead (for example https://api.capown.net).",
  registrationUrl: "Registration link",
  registrationToken: "Registration token",
  publicUrlMissing:
    "Master did not return a public link. Configure CAPOWN_MASTER_PUBLIC_URL to create a shareable URL.",
  clientAccess: "Client and MCP access",
  clientAccessHint:
    "Create a long-lived token for the Python Client, REST API, or MCP.",
  clientLabel: "Client label (optional)",
  createClientToken: "Create token",
  creatingClientToken: "Creating token...",
  clientTokenCreated: "Client token created",
  masterUrl: "Master URL",
  clientToken: "Client token",
  clientConfig: "Python Client config",
  clientTokenManagement: "Client token management",
  clientTokenManagementHint:
    "Review active Client/MCP tokens and their recent usage.",
  clientTokenCreatedAt: "Created",
  clientTokenLastUsed: "Last used",
  clientTokenLastIp: "Last IP",
  clientTokenNeverUsed: "Never used",
  clientTokenNotRecorded: "Not recorded",
  clientTokenActive: "Active",
  clientTokenDisabled: "Disabled",
  clientTokenRevoked: "Revoked",
  disableClientToken: "Disable",
  enableClientToken: "Enable",
  revokeClientToken: "Revoke",
  clientTokenDisableWarning:
    "Disabled tokens cannot authenticate until they are enabled again. Continue?",
  clientTokenRevokeWarning:
    "Revoking this token is permanent and immediately disconnects its clients. Continue?",
  clientTokenLoadError: "Failed to load Client tokens",
  clientTokenUpdateError: "Failed to update Client token",
  clientTokenRevokeError: "Failed to revoke Client token",
  noClientTokens: "No Client tokens",
  secretShownOnce:
    "The plaintext credential is shown only once. Copy it now; Dashboard does not store it.",
  credentialCreateError: "Unable to create credential",
  copyError: "Unable to copy to clipboard",
  copied: "Copied",
  copy: "Copy",
  signOut: "Sign out",
  signingOut: "Signing out...",
  logoutError: "Sign out failed. Refresh and try again.",
  language: "中文",
  connectedMaster: "Current Master",
  account: "Account",
  role: "Role",
  session: "Session expires",
  welcome: "Welcome back",
  overviewHint: "Monitor and manage your CapOwn environment.",
  workerTitle: "Workers",
  workerHint: "Live view of automation nodes owned by this account.",
  adminWorkerHint: "Live view of Workers across every account.",
  adminWorkerScope:
    "Administrator view includes Workers owned by other accounts.",
  owner: "Owner",
  currentAccount: "current account",
  refresh: "Refresh",
  loading: "Loading...",
  noWorkers: "No workers yet",
  noWorkersHint: "Register a Worker to start managing plugins and automation.",
  online: "Online",
  offline: "Offline",
  host: "Host",
  mode: "Mode",
  capabilities: "Capabilities",
  workspace: "Workspace",
  heartbeat: "Last heartbeat",
  registered: "Registered",
  revoke: "Revoke",
  revokeTitle: "Permanently revoke worker",
  revokeWarning:
    "The Worker will disconnect immediately and needs a new registration link to connect again. This cannot be undone.",
  typeName: "Type the Worker name to confirm",
  cancel: "Cancel",
  revoking: "Revoking...",
  confirmRevoke: "Permanently revoke",
  connectionError: "Connection failed. Please try again.",
  fetchError: "Failed to fetch Workers",
  revokeError: "Failed to revoke Worker",
  plugins: "Plugins",
  noPlugins: "This Worker has not reported any plugins.",
  pluginTools: "Tools",
  enablePlugin: "Enable",
  disablePlugin: "Disable",
  updatingPlugin: "Updating...",
  disablePluginWarning:
    "Disabling this plugin stops its process and cancels active plugin calls. Continue?",
  pluginUpdateError: "Failed to update plugin state",
  pluginUpdateTimeout: "Plugin state update timed out",
  userManagement: "Account management",
  userManagementHint:
    "Enable, disable, or permanently deprovision Master accounts.",
  enableUser: "Enable account",
  disableUser: "Disable account",
  deleteUser: "Deprovision",
  deleteUserWarning:
    "Deprovisioning is irreversible and revokes the account's tokens, registrations, and Workers. Continue?",
  noUsers: "No accounts",
  userLoadError: "Failed to load accounts",
  userUpdateError: "Failed to update account status",
  userDeleteError: "Failed to deprovision account",
  invitations: "User invitations",
  invitationsHint:
    "Generate one-time codes for users to create Master accounts. Codes expire after seven days.",
  invitationLabel: "Label, for example: Invite Alice",
  createInvitation: "Create invitation",
  creatingInvitation: "Creating...",
  invitationCreated: "Invitation created",
  invitationSecretWarning:
    "The plaintext code is shown only once. Copy it now and send it securely.",
  expires: "expires",
  revokeInvitation: "Revoke",
  noInvitations: "No invitations",
  invitationLoadError: "Failed to load invitations",
  invitationCreateError: "Failed to create invitation",
  invitationRevokeError: "Failed to revoke invitation",
} as const;

const zh: Record<keyof typeof en, string> = {
  credentialsTitle: "连接凭据",
  credentialsHint: "创建临时 Worker 注册链接，或长期有效的 Client/MCP 令牌。",
  workerRegistration: "Worker 注册",
  workerRegistrationHint: "生成短期注册链接，将新的 Worker 接入当前账户。",
  workerLabel: "Worker 标签（可选）",
  createWorkerRegistration: "注册 Worker",
  creatingWorkerRegistration: "正在创建注册链接...",
  workerRegistrationCreated: "Worker 注册凭据已创建",
  workerRegisterCommand: "Worker 注册命令",
  workerRegisterCommandLocalHint:
    "当前 Master 地址是本机地址。若 Worker 部署在其他机器上，请改用可从外部访问的公网或反向代理地址（例如 https://api.capown.net）。",
  registrationUrl: "注册链接",
  registrationToken: "注册令牌",
  publicUrlMissing: "Master 未返回公开链接。请配置 CAPOWN_MASTER_PUBLIC_URL。",
  clientAccess: "Client 与 MCP 访问",
  clientAccessHint: "为 Python Client、REST API 或 MCP 创建长期访问令牌。",
  clientLabel: "Client 标签（可选）",
  createClientToken: "创建令牌",
  creatingClientToken: "正在创建令牌...",
  clientTokenCreated: "Client 令牌已创建",
  masterUrl: "Master 地址",
  clientToken: "Client 令牌",
  clientConfig: "Python Client 配置",
  clientTokenManagement: "Client 令牌管理",
  clientTokenManagementHint: "查看 Client/MCP 令牌状态及最近使用记录。",
  clientTokenCreatedAt: "创建时间",
  clientTokenLastUsed: "最后使用",
  clientTokenLastIp: "最后 IP",
  clientTokenNeverUsed: "尚未使用",
  clientTokenNotRecorded: "未记录",
  clientTokenActive: "启用",
  clientTokenDisabled: "已停用",
  clientTokenRevoked: "已吊销",
  disableClientToken: "停用",
  enableClientToken: "启用",
  revokeClientToken: "吊销",
  clientTokenDisableWarning:
    "停用后令牌将无法鉴权，重新启用后才能恢复。是否继续？",
  clientTokenRevokeWarning:
    "吊销令牌不可恢复，并会立即断开使用它的客户端。是否继续？",
  clientTokenLoadError: "无法加载 Client 令牌",
  clientTokenUpdateError: "无法更新 Client 令牌",
  clientTokenRevokeError: "无法吊销 Client 令牌",
  noClientTokens: "暂无 Client 令牌",
  secretShownOnce: "明文凭据只显示一次，请立即复制；Dashboard 不会保存它。",
  credentialCreateError: "无法创建凭据",
  copyError: "无法复制到剪贴板",
  copied: "已复制",
  copy: "复制",
  signOut: "退出登录",
  signingOut: "正在退出...",
  logoutError: "退出失败，请刷新后重试。",
  language: "EN",
  connectedMaster: "当前 Master",
  account: "账户",
  role: "角色",
  session: "会话到期时间",
  welcome: "欢迎回来",
  overviewHint: "查看并管理你的 CapOwn 环境。",
  workerTitle: "Workers",
  workerHint: "实时查看当前账户拥有的自动化节点。",
  adminWorkerHint: "实时查看所有账户的 Worker。",
  adminWorkerScope: "管理员视图包含其他账户拥有的 Worker。",
  owner: "所有者",
  currentAccount: "当前账户",
  refresh: "刷新",
  loading: "正在加载...",
  noWorkers: "暂无 Worker",
  noWorkersHint: "注册一个 Worker 后即可开始管理插件和自动化。",
  online: "在线",
  offline: "离线",
  host: "主机",
  mode: "模式",
  capabilities: "能力",
  workspace: "工作目录",
  heartbeat: "最后心跳",
  registered: "注册时间",
  revoke: "注销",
  revokeTitle: "永久注销 Worker",
  revokeWarning:
    "Worker 会立即断开，之后必须使用新的注册链接才能再次接入。此操作无法撤销。",
  typeName: "输入 Worker 名称以确认",
  cancel: "取消",
  revoking: "正在注销...",
  confirmRevoke: "永久注销",
  connectionError: "连接失败，请稍后重试。",
  fetchError: "无法获取 Worker 列表",
  revokeError: "无法注销 Worker",
  plugins: "插件",
  noPlugins: "此 Worker 尚未上报插件。",
  pluginTools: "工具",
  enablePlugin: "启用",
  disablePlugin: "禁用",
  updatingPlugin: "处理中...",
  disablePluginWarning: "禁用插件会停止其进程并取消正在执行的调用，是否继续？",
  pluginUpdateError: "无法更新插件状态",
  pluginUpdateTimeout: "插件状态更新超时",
  userManagement: "账户管理",
  userManagementHint: "启用、禁用或永久注销 Master 账户。",
  enableUser: "启用账户",
  disableUser: "禁用账户",
  deleteUser: "注销账户",
  deleteUserWarning:
    "注销不可恢复，并会撤销该账户的令牌、注册链接和 Worker。是否继续？",
  noUsers: "暂无账户",
  userLoadError: "无法加载账户列表",
  userUpdateError: "无法更新账户状态",
  userDeleteError: "无法注销账户",
  invitations: "用户邀请",
  invitationsHint:
    "生成一次性邀请码，供用户创建 Master 账户。邀请码七天后过期。",
  invitationLabel: "备注，例如：邀请 Alice",
  createInvitation: "创建邀请",
  creatingInvitation: "正在创建...",
  invitationCreated: "邀请已创建",
  invitationSecretWarning: "明文邀请码只显示一次，请立即复制并安全发送。",
  expires: "到期",
  revokeInvitation: "撤销",
  noInvitations: "暂无邀请",
  invitationLoadError: "无法加载邀请",
  invitationCreateError: "无法创建邀请",
  invitationRevokeError: "无法撤销邀请",
};

const messages = { en, zh };
type MessageKey = keyof typeof en;

interface LocaleContextValue {
  locale: Locale;
  toggleLocale: () => void;
  t: (key: MessageKey) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>("zh");

  useEffect(() => {
    const saved = window.localStorage.getItem("capown_locale");
    if (saved === "zh" || saved === "en") setLocale(saved);
    else if (!navigator.language.toLowerCase().startsWith("zh"))
      setLocale("en");
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      toggleLocale: () =>
        setLocale((current) => {
          const next = current === "zh" ? "en" : "zh";
          window.localStorage.setItem("capown_locale", next);
          return next;
        }),
      t: (key) => messages[locale][key],
    }),
    [locale],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) throw new Error("useLocale must be used within LocaleProvider");
  return context;
}
