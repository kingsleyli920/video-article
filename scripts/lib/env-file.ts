import { existsSync, readFileSync } from 'node:fs';

/** 解析 KEY=VALUE 格式的 .env，忽略空行和 # 注释，去掉值两侧的引号。 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    out[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
}
