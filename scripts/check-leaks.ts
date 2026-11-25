/**
 * 检查凭据有没有进入不该去的地方：前端构建产物、Worker 打包产物、.dev.vars。
 * 只报告"在哪个文件发现了哪一项"，不输出任何密钥值。
 *   npm run check:leaks
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile } from './lib/env-file';

const env = readEnvFile('.env');
const secrets = {
  CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN ?? '',
  GEMINI_API_KEY: env.GEMINI_API_KEY ?? '',
};
type SecretName = keyof typeof secrets;

const targets: { path: string; forbidden: SecretName[] }[] = [
  { path: 'dist/client', forbidden: ['CLOUDFLARE_API_TOKEN', 'GEMINI_API_KEY'] },
  { path: '.wrangler/dry-run', forbidden: ['CLOUDFLARE_API_TOKEN', 'GEMINI_API_KEY'] },
  { path: '.dev.vars', forbidden: ['CLOUDFLARE_API_TOKEN'] },
];

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

let leaks = 0;
for (const { path, forbidden } of targets) {
  const contents = files(path).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  if (contents.length === 0) {
    console.log(`${path}：不存在，跳过`);
    continue;
  }
  for (const name of forbidden) {
    const value = secrets[name];
    // .dev.vars 里连变量名也不允许出现；其他产物按值检查
    const hits = contents.filter(({ file, text }) => (value && text.includes(value)) || (file === '.dev.vars' && text.includes(name)));
    if (hits.length) {
      leaks += hits.length;
      console.log(`${path}：发现 ${name} → ${hits.map((h) => h.file).join(', ')}`);
    } else {
      console.log(`${path}：未发现 ${name}（检查 ${contents.length} 个文件${value ? '' : '；.env 未配置该值'}）`);
    }
  }
}
process.exit(leaks > 0 ? 1 : 0);
