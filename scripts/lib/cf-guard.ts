/**
 * Cloudflare 远程操作的账户核对。所有 wrangler 远程命令都必须经过这里：
 * 1. 只用项目 .env 里的令牌和完整 Account ID，缺任何一项就停；
 * 2. 先用只读接口核对令牌有效、账户 ID 完全一致、令牌不能访问其他账户、具备 Workers 权限；
 * 3. 写操作还要求本地有一份与当前账户名和 ID 完全一致的人工确认记录；
 * 4. 子进程环境从零构建，只放系统必需变量和这两项凭据，其他 Cloudflare 认证变量一律不带。
 */

export const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;

export class GuardError extends Error {}

export interface Credentials {
  token: string;
  accountId: string;
  /** .env 里记录的、用户确认过的账户名；填写后要求接口返回的名称完全一致 */
  accountName?: string;
}

export interface VerifiedAccount {
  accountId: string;
  accountName: string;
  tokenKind: 'account' | 'user';
  workersSubdomain: string | null;
}

export interface Confirmation {
  accountId: string;
  accountName: string;
  confirmedAt: string;
}

export function readCredentials(env: Record<string, string | undefined>): Credentials {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim().toLowerCase();
  if (!token) throw new GuardError('.env 里没有 CLOUDFLARE_API_TOKEN，不执行远程操作，也不会改用本机的全局登录');
  if (!accountId || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new GuardError('CLOUDFLARE_ACCOUNT_ID 必须是完整的 32 位十六进制账户 ID');
  }
  const accountName = env.CLOUDFLARE_ACCOUNT_NAME?.trim() || undefined;
  return { token, accountId, accountName };
}

interface CfResponse<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function verifyAccount(creds: Credentials, fetchFn: FetchFn = fetch): Promise<VerifiedAccount> {
  const api = async <T>(path: string): Promise<CfResponse<T> & { status: number }> => {
    let res: Response;
    try {
      res = await fetchFn(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${creds.token}` } });
    } catch {
      throw new GuardError(`无法连接 Cloudflare API（${path}）`);
    }
    const body = (await res.json().catch(() => ({ success: false, result: null }))) as CfResponse<T>;
    return { ...body, status: res.status };
  };

  // 1. 令牌有效：先按账户级令牌核对，再按用户令牌核对
  let tokenKind: VerifiedAccount['tokenKind'];
  const accountToken = await api<{ status: string }>(`/accounts/${creds.accountId}/tokens/verify`);
  if (accountToken.success && accountToken.result?.status === 'active') {
    tokenKind = 'account';
  } else {
    const userToken = await api<{ status: string }>('/user/tokens/verify');
    if (!(userToken.success && userToken.result?.status === 'active')) throw new GuardError('Cloudflare 令牌无效、已停用或已过期');
    tokenKind = 'user';
  }

  // 2. 目标账户：完整 ID 必须一致
  const account = await api<{ id: string; name: string }>(`/accounts/${creds.accountId}`);
  if (!account.success || !account.result) throw new GuardError('令牌无法访问 .env 里指定的账户');
  if (account.result.id !== creds.accountId) {
    throw new GuardError(`账户 ID 不一致：接口返回 ${account.result.id}，.env 指定 ${creds.accountId}`);
  }
  if (creds.accountName && account.result.name !== creds.accountName) {
    throw new GuardError(`账户名称不一致：接口返回「${account.result.name}」，.env 记录「${creds.accountName}」`);
  }

  // 3. 令牌范围：不能还能访问别的账户
  const accounts = await api<{ id: string }[]>('/accounts?per_page=50');
  if (accounts.success) {
    const others = (accounts.result ?? []).filter((a) => a.id !== creds.accountId);
    if (others.length > 0) throw new GuardError(`令牌还能访问另外 ${others.length} 个账户，请把令牌的账户范围限定为个人账户`);
  } else if (tokenKind === 'user') {
    throw new GuardError('无法列出令牌可访问的账户，不能确认令牌范围');
  }

  // 4. 实际需要的权限（只读探测）：Workers 脚本、workers.dev 子域名
  const scripts = await api<unknown[]>(`/accounts/${creds.accountId}/workers/scripts`);
  if (!scripts.success) throw new GuardError('令牌缺少 Workers Scripts 权限');
  const subdomain = await api<{ subdomain: string }>(`/accounts/${creds.accountId}/workers/subdomain`);
  if (!subdomain.success && subdomain.status !== 404 && !subdomain.errors?.some((e) => e.code === 10007)) {
    throw new GuardError('令牌无法读取 workers.dev 子域名设置');
  }

  return {
    accountId: account.result.id,
    accountName: account.result.name,
    tokenKind,
    workersSubdomain: subdomain.success ? subdomain.result.subdomain : null,
  };
}

const READ_ONLY_COMMANDS = [['whoami'], ['tail'], ['deployments', 'list'], ['versions', 'list']];

export function isReadOnly(args: string[]): boolean {
  return READ_ONLY_COMMANDS.some((cmd) => cmd.every((part, i) => args[i] === part));
}

export function assertConfirmed(confirmation: Confirmation | null, verified: VerifiedAccount): void {
  if (!confirmation) throw new GuardError(`账户「${verified.accountName}」还没有经过人工确认，写操作已停止`);
  if (confirmation.accountId !== verified.accountId || confirmation.accountName !== verified.accountName) {
    throw new GuardError('人工确认记录与当前账户不一致，写操作已停止');
  }
}

const PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR', 'FORCE_COLOR'];

/** 子进程环境从零构建：系统必需变量 + 项目令牌和账户 ID。CLOUDFLARE_API_KEY、CLOUDFLARE_EMAIL、CF_* 等都不会带过去。 */
export function buildChildEnv(parent: Record<string, string | undefined>, creds: Credentials): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.CLOUDFLARE_API_TOKEN = creds.token;
  env.CLOUDFLARE_ACCOUNT_ID = creds.accountId;
  env.WRANGLER_SEND_METRICS = 'false';
  return env;
}

export interface RemoteDeps {
  projectEnv: Record<string, string | undefined>;
  parentEnv: Record<string, string | undefined>;
  fetchFn?: FetchFn;
  readConfirmation: () => Confirmation | null;
  spawn: (args: string[], env: Record<string, string>) => number;
}

/** 核对通过才启动 wrangler；任何一步失败都抛 GuardError，子进程不会被启动。 */
export async function runWrangler(args: string[], deps: RemoteDeps): Promise<number> {
  const creds = readCredentials(deps.projectEnv);
  const verified = await verifyAccount(creds, deps.fetchFn);
  if (!isReadOnly(args)) assertConfirmed(deps.readConfirmation(), verified);
  return deps.spawn(args, buildChildEnv(deps.parentEnv, creds));
}
