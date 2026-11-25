/** 构建前端静态资源到 dist/client。不读取任何环境变量，构建产物里不会带进凭据。 */
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';

const OUT = 'dist/client';

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await build({
  entryPoints: ['src/client/main.ts'],
  outfile: `${OUT}/app.js`,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  logLevel: 'warning',
});
await Promise.all(['index.html', 'styles.css'].map((file) => copyFile(`src/client/${file}`, `${OUT}/${file}`)));
console.log(`前端已构建到 ${OUT}`);
