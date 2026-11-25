/**
 * Cloudflare 远程操作的唯一入口（见 lib/cf-guard.ts）。
 *   npm run cf:verify                     只读核对账户、令牌范围和权限，并确认 wrangler 用的是项目令牌
 *   npm run cf:confirm -- "<账户名>"       你在对话里确认是个人账户后，记录这次确认
 *   npm run cf:secret:gemini              把 .env 里的 GEMINI_API_KEY 单独写成线上 secret（经 stdin，不进命令行）
 *   npm run deploy                        构建并部署
 *   npm run cf:deploy-check               部署后只读检查：线上版本、变量与 wrangler.jsonc 一致、测试专用变量不在线上、secret 存在
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildChildEnv,
  GuardError,
  readCredentials,
  runWrangler,
  verifyAccount,
  type Confirmation,
  type RemoteDeps,
} from './lib/cf-guard';
import { readEnvFile } from './lib/env-file';

const CONFIRMATION_FILE = '.cf-account-confirmed.json';
const WRANGLER = resolve('node_modules/.bin/wrangler');

const projectEnv = readEnvFile('.env');
const readConfirmation = (): Confirmation | null =>
  existsSync(CONFIRMATION_FILE) ? (JSON.parse(readFileSync(CONFIRMATION_FILE, 'utf8')) as Confirmation) : null;

function deps(stdin?: string): RemoteDeps {
  return {
    projectEnv,
    parentEnv: process.env,
    readConfirmation,
    spawn: (args, env) => {
      const result = spawnSync(WRANGLER, args, { env, input: stdin, stdio: [stdin === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
      return result.status ?? 1;
    },
  };
}

async function verify(): Promise<void> {
  const creds = readCredentials(projectEnv);
  const account = await verifyAccount(creds);
  console.log(`账户名称：${account.accountName}`);
  console.log(`账户 ID：${account.accountId}（与 .env 完整一致）`);
  console.log(`令牌类型：${account.tokenKind === 'account' ? '账户级令牌' : '用户令牌'}，只能访问这一个账户`);
  console.log('Workers Scripts 读取：通过（编辑权限只能在第一次写操作时验证）');
  console.log(`workers.dev 子域名：${account.workersSubdomain ?? '尚未开通'}`);

  // wrangler 必须使用项目令牌，不能落到本机的全局 OAuth 登录上
  const whoami = spawnSync(WRANGLER, ['whoami'], { env: buildChildEnv(process.env, creds), encoding: 'utf8' });
  const output = `${whoami.stdout}\n${whoami.stderr}`;
  if (/OAuth/i.test(output) || !/API Token/i.test(output) || !output.includes(creds.accountId)) {
    throw new GuardError('wrangler whoami 没有显示正在使用项目令牌访问该账户，已停止');
  }
  console.log('wrangler 认证：使用项目 API 令牌（未使用全局 OAuth 登录）');

  const confirmation = readConfirmation();
  const confirmed = confirmation?.accountId === account.accountId && confirmation.accountName === account.accountName;
  console.log(confirmed ? `人工确认：已于 ${confirmation!.confirmedAt} 确认` : '人工确认：尚未确认，写操作会被拒绝');
}

/** 只在本地 E2E 使用的变量，线上一律不能有（见 src/worker/env.d.ts） */
const TEST_ONLY_VARS = ['GEMINI_API_BASE', 'YOUTUBE_PLAYER_URL', 'TIMEOUT_SCALE'];

async function deployCheck(): Promise<void> {
  const creds = readCredentials(projectEnv);
  const account = await verifyAccount(creds);
  const api = async (path: string) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account.accountId}/workers${path}`, {
      headers: { authorization: `Bearer ${creds.token}` },
    });
    const body = (await res.json()) as { success: boolean; result: unknown; errors?: unknown };
    if (!body.success) throw new GuardError(`读取 ${path} 失败：${JSON.stringify(body.errors)}`);
    return body.result;
  };
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '')) as { name: string; vars: Record<string, string> };
  const problems: string[] = [];

  const { deployments } = (await api(`/scripts/${config.name}/deployments`)) as { deployments: { created_on: string; versions: { version_id: string; percentage: number }[] }[] };
  const latest = deployments[0];
  const full = latest?.versions.find((v) => v.percentage === 100);
  if (!full) problems.push('最新部署没有一个承接 100% 流量的版本');
  console.log(`线上版本：${full?.version_id ?? '无'}（部署于 ${latest?.created_on ?? '未知'}）`);

  const { bindings } = (await api(`/scripts/${config.name}/settings`)) as { bindings: { name: string; type: string; text?: string }[] };
  const byName = new Map(bindings.map((b) => [b.name, b]));
  for (const [name, value] of Object.entries(config.vars)) {
    const binding = byName.get(name);
    if (binding?.type !== 'plain_text' || binding.text !== value) problems.push(`变量 ${name} 是 ${binding?.text ?? '（缺失）'}，wrangler.jsonc 里是 ${value}`);
  }
  for (const name of TEST_ONLY_VARS) if (byName.has(name)) problems.push(`线上出现了测试专用变量 ${name}`);
  if (byName.get('GEMINI_API_KEY')?.type !== 'secret_text') problems.push('缺少 secret GEMINI_API_KEY');
  if (byName.get('GENERATIONS')?.type !== 'durable_object_namespace') problems.push('缺少 Durable Object 绑定 GENERATIONS');
  console.log(`绑定：${bindings.map((b) => `${b.name}（${b.type}${b.type === 'plain_text' ? `=${b.text}` : ''}）`).join('、')}`);

  const scripts = (await api('/scripts')) as { id: string; modified_on: string }[];
  console.log(`账户内 Worker：${scripts.map((s) => `${s.id}（修改于 ${s.modified_on}）`).join('；')}`);

  if (problems.length) throw new GuardError(`部署检查未通过：\n- ${problems.join('\n- ')}`);
  console.log('部署检查通过');
}

async function confirm(name: string): Promise<void> {
  const account = await verifyAccount(readCredentials(projectEnv));
  if (!name || name !== account.accountName) {
    throw new GuardError(`确认用的账户名与实际账户名「${account.accountName}」不一致，未记录`);
  }
  const record: Confirmation = { accountId: account.accountId, accountName: account.accountName, confirmedAt: new Date().toISOString() };
  writeFileSync(CONFIRMATION_FILE, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log(`已记录确认：${account.accountName}（${account.accountId}）`);
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'verify':
      await verify();
      return 0;
    case 'confirm':
      await confirm(rest.join(' ').trim());
      return 0;
    case 'wrangler':
      return runWrangler(rest, deps());
    case 'deploy-check':
      await deployCheck();
      return 0;
    case 'secret-gemini': {
      const key = projectEnv.GEMINI_API_KEY;
      if (!key) throw new GuardError('.env 里没有 GEMINI_API_KEY');
      return runWrangler(['secret', 'put', 'GEMINI_API_KEY'], deps(key));
    }
    default:
      console.error('用法：tsx scripts/cf.ts verify | confirm <账户名> | wrangler <参数…> | secret-gemini | deploy-check');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof GuardError ? `已停止：${err.message}` : err);
    process.exit(1);
  },
);
