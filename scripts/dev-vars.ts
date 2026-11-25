import { writeFileSync } from 'node:fs';
import { devVarsContent } from './lib/dev-vars';
import { readEnvFile } from './lib/env-file';

try {
  const { content, keys } = devVarsContent(readEnvFile('.env'));
  writeFileSync('.dev.vars', content, { mode: 0o600 });
  console.log(`.dev.vars 已生成，包含：${keys.join(', ')}`);
} catch (err) {
  console.error(`无法生成 .dev.vars：${(err as Error).message}`);
  process.exit(1);
}
