/**
 * Cloudflare 远程操作的唯一入口（见 lib/cf-guard.ts）。
 *   npm run cf:verify                     只读核对账户、令牌范围和权限，并确认 wrangler 用的是项目令牌
 *   npm run cf:confirm -- "<账户名>"       你在对话里确认是个人账户后，记录这次确认
 *   npm run cf:secret:gemini              把 .env 里的 GEMINI_API_KEY 单独写成线上 secret（经 stdin，不进命令行）
 *   npm run deploy                        构建并部署
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
    case 'secret-gemini': {
      const key = projectEnv.GEMINI_API_KEY;
      if (!key) throw new GuardError('.env 里没有 GEMINI_API_KEY');
      return runWrangler(['secret', 'put', 'GEMINI_API_KEY'], deps(key));
    }
    default:
      console.error('用法：tsx scripts/cf.ts verify | confirm <账户名> | wrangler <参数…> | secret-gemini');
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
