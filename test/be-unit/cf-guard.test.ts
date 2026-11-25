import { describe, expect, it, vi } from 'vitest';
import { buildChildEnv, isReadOnly, readCredentials, runWrangler, verifyAccount, type RemoteDeps } from '../../scripts/lib/cf-guard';

const ACCOUNT_ID = 'd5c30000000000000000000000009585';
const OTHER_ID = 'aaaa0000000000000000000000009585'; // 末四位相同，只核对末四位就会放行
const TOKEN = 'project-token';

interface Api {
  accountVerify?: object;
  userVerify?: object;
  account?: object;
  accounts?: object;
  scripts?: object;
  subdomain?: object;
}

const ok = (result: unknown) => ({ success: true, result });
const fail = { success: false, result: null, errors: [{ code: 1000, message: 'denied' }] };

function fakeApi(overrides: Api = {}) {
  const api: Required<Api> = {
    accountVerify: ok({ status: 'active' }),
    userVerify: fail,
    account: ok({ id: ACCOUNT_ID, name: '个人账户' }),
    accounts: ok([{ id: ACCOUNT_ID }]),
    scripts: ok([]),
    subdomain: ok({ subdomain: 'me' }),
    ...overrides,
  };
  return vi.fn(async (url: string) => {
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    const body =
      path === `/accounts/${ACCOUNT_ID}/tokens/verify` ? api.accountVerify
      : path === '/user/tokens/verify' ? api.userVerify
      : path === `/accounts/${ACCOUNT_ID}` ? api.account
      : path.startsWith('/accounts?') ? api.accounts
      : path === `/accounts/${ACCOUNT_ID}/workers/scripts` ? api.scripts
      : path === `/accounts/${ACCOUNT_ID}/workers/subdomain` ? api.subdomain
      : fail;
    return Response.json(body);
  });
}

function deps(overrides: Partial<RemoteDeps> & { api?: Api } = {}): RemoteDeps & { spawn: ReturnType<typeof vi.fn> } {
  return {
    projectEnv: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    parentEnv: { PATH: '/usr/bin', HOME: '/Users/me' },
    fetchFn: fakeApi(overrides.api),
    readConfirmation: () => ({ accountId: ACCOUNT_ID, accountName: '个人账户', confirmedAt: '2026-11-24T00:00:00Z' }),
    spawn: vi.fn(() => 0),
    ...overrides,
  } as RemoteDeps & { spawn: ReturnType<typeof vi.fn> };
}

describe('readCredentials', () => {
  // 抓：项目令牌缺失时继续执行，wrangler 会悄悄用上本机全局 OAuth 登录
  it('读取完整 ID、令牌和可选的期望账户名', () => {
    expect(readCredentials({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID.toUpperCase(), CLOUDFLARE_ACCOUNT_NAME: ' 个人账户 ' })).toEqual({
      token: TOKEN,
      accountId: ACCOUNT_ID,
      accountName: '个人账户',
    });
  });

  it('没有项目令牌时拒绝', () => {
    expect(() => readCredentials({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID })).toThrow('.env 里没有 CLOUDFLARE_API_TOKEN');
  });

  // 抓：只填了末四位或格式不对的账户 ID 被接受
  it.each(['9585', `${ACCOUNT_ID}0`, ACCOUNT_ID.replace('d', 'g'), ''])('账户 ID 不是完整 32 位十六进制时拒绝：%s', (id) => {
    expect(() => readCredentials({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: id })).toThrow('完整的 32 位十六进制账户 ID');
  });
});

describe('verifyAccount', () => {
  it('全部核对通过时返回账户名、完整 ID 和子域名', async () => {
    await expect(verifyAccount({ token: TOKEN, accountId: ACCOUNT_ID }, fakeApi())).resolves.toEqual({
      accountId: ACCOUNT_ID,
      accountName: '个人账户',
      tokenKind: 'account',
      workersSubdomain: 'me',
    });
  });

  it('令牌无效时拒绝', async () => {
    await expect(verifyAccount({ token: TOKEN, accountId: ACCOUNT_ID }, fakeApi({ accountVerify: fail, userVerify: fail }))).rejects.toThrow('令牌无效');
  });

  // 抓：只比较末四位，接口返回了另一个账户也放行
  it('接口返回的账户 ID 与 .env 不完全一致时拒绝', async () => {
    await expect(verifyAccount({ token: TOKEN, accountId: ACCOUNT_ID }, fakeApi({ account: ok({ id: OTHER_ID, name: '公司账户' }) }))).rejects.toThrow('账户 ID 不一致');
  });

  // 抓：ID 填对了但令牌实际指向的账户名与用户确认的个人账户不符
  it('.env 记录了账户名时，接口返回的名称必须完全一致', async () => {
    const creds = { token: TOKEN, accountId: ACCOUNT_ID, accountName: "someone@example.com's Account" };
    await expect(verifyAccount(creds, fakeApi())).rejects.toThrow('账户名称不一致');
    await expect(verifyAccount({ ...creds, accountName: '个人账户' }, fakeApi())).resolves.toMatchObject({ accountName: '个人账户' });
  });

  // 抓：令牌范围过宽（同时能访问公司账户）也被接受
  it('令牌还能访问其他账户时拒绝', async () => {
    await expect(verifyAccount({ token: TOKEN, accountId: ACCOUNT_ID }, fakeApi({ accounts: ok([{ id: ACCOUNT_ID }, { id: OTHER_ID }]) }))).rejects.toThrow('令牌还能访问另外 1 个账户');
  });

  it('缺少 Workers Scripts 权限时拒绝', async () => {
    await expect(verifyAccount({ token: TOKEN, accountId: ACCOUNT_ID }, fakeApi({ scripts: fail }))).rejects.toThrow('缺少 Workers Scripts 权限');
  });

  it('workers.dev 子域名未开通时返回 null 而不是报错', async () => {
    const api = fakeApi({ subdomain: { success: false, result: null, errors: [{ code: 10007, message: 'not found' }] } });
    await expect(verifyAccount({ token: TOKEN, accountId: ACCOUNT_ID }, api)).resolves.toMatchObject({ workersSubdomain: null });
  });
});

describe('runWrangler', () => {
  // 抓：核对失败后仍然启动了 wrangler 子进程
  it.each([
    ['令牌缺失', deps({ projectEnv: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID } })],
    ['账户不一致', deps({ api: { account: ok({ id: OTHER_ID, name: '公司账户' }) } })],
    ['令牌无效', deps({ api: { accountVerify: fail, userVerify: fail } })],
  ])('%s时不启动 wrangler', async (_, d) => {
    await expect(runWrangler(['deploy'], d)).rejects.toThrow();
    expect(d.spawn).not.toHaveBeenCalled();
  });

  // 抓：账户还没经过人工确认就执行部署或写 secret
  it('写操作没有人工确认记录时拒绝', async () => {
    const d = deps({ readConfirmation: () => null });
    await expect(runWrangler(['deploy'], d)).rejects.toThrow('还没有经过人工确认');
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('确认记录的账户名与当前账户不一致时拒绝写操作', async () => {
    const d = deps({ readConfirmation: () => ({ accountId: ACCOUNT_ID, accountName: '别的名字', confirmedAt: '' }) });
    await expect(runWrangler(['secret', 'put', 'GEMINI_API_KEY'], d)).rejects.toThrow('人工确认记录与当前账户不一致');
  });

  it('只读命令不需要人工确认', async () => {
    const d = deps({ readConfirmation: () => null });
    await expect(runWrangler(['whoami'], d)).resolves.toBe(0);
    expect(d.spawn).toHaveBeenCalledOnce();
  });

  // 抓：子进程继承了父进程里的其他 Cloudflare 认证变量
  it('核对通过后启动 wrangler，子进程环境只含白名单变量和项目凭据', async () => {
    const d = deps({
      parentEnv: { PATH: '/usr/bin', HOME: '/Users/me', CLOUDFLARE_API_KEY: 'global-key', CLOUDFLARE_EMAIL: 'a@b.c', CF_API_TOKEN: 'old', CLOUDFLARE_API_TOKEN: 'shell-token', GEMINI_API_KEY: 'g' },
    });
    await runWrangler(['deploy'], d);
    expect(d.spawn).toHaveBeenCalledWith(['deploy'], {
      PATH: '/usr/bin',
      HOME: '/Users/me',
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      WRANGLER_SEND_METRICS: 'false',
    });
  });
});

describe('辅助函数', () => {
  it('isReadOnly 只认白名单里的只读命令', () => {
    expect(isReadOnly(['whoami'])).toBe(true);
    expect(isReadOnly(['deployments', 'list'])).toBe(true);
    expect(isReadOnly(['deploy'])).toBe(false);
    expect(isReadOnly(['deployments', 'rollback'])).toBe(false);
  });

  it('buildChildEnv 不修改 HOME', () => {
    expect(buildChildEnv({ HOME: '/Users/me' }, { token: TOKEN, accountId: ACCOUNT_ID }).HOME).toBe('/Users/me');
  });
});
