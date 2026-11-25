export {};

/**
 * 启动或部署后的冒烟检查：只走 HTTP，不调用模型，不消耗额度。
 *   npm run smoke -- <站点地址>      例如 http://127.0.0.1:8787（本地 npm run dev）或线上地址
 * 检查页面和静态资源能取到、接口的路由和输入校验、错误响应的格式。全部通过返回 0。
 */
const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('用法：npm run smoke -- <站点地址>');
  process.exit(2);
}

interface Check {
  name: string;
  run: () => Promise<string | null>;
}

const UNKNOWN_ID = '0'.repeat(64);
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** 期望接口返回指定状态码和错误码；不符时返回问题描述 */
async function expectError(path: string, init: RequestInit, status: number, code: string): Promise<string | null> {
  const res = await fetch(`${base}${path}`, init);
  const type = res.headers.get('content-type') ?? '';
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (res.status !== status) return `状态码 ${res.status}，期望 ${status}`;
  if (!type.includes('application/json')) return `content-type 是 ${type}`;
  if (body?.error?.code !== code) return `错误码 ${body?.error?.code}，期望 ${code}`;
  if (!body.error.message) return '错误响应缺少 message';
  return null;
}

const checks: Check[] = [
  {
    name: '首页：200、HTML、标题、引用 app.js 和 styles.css',
    run: async () => {
      const res = await fetch(`${base}/`);
      const html = await res.text();
      if (res.status !== 200) return `状态码 ${res.status}`;
      if (!(res.headers.get('content-type') ?? '').includes('text/html')) return `content-type 是 ${res.headers.get('content-type')}`;
      if (!html.includes('<title>视频对话文章</title>')) return '标题不对';
      if (!html.includes('src="/app.js"') || !html.includes('href="/styles.css"')) return '没有引用 app.js 或 styles.css';
      return null;
    },
  },
  {
    name: '静态资源：app.js 和 styles.css 可取到，类型正确',
    run: async () => {
      for (const [path, type] of [['/app.js', 'javascript'], ['/styles.css', 'text/css']] as const) {
        const res = await fetch(`${base}${path}`);
        const size = (await res.arrayBuffer()).byteLength;
        if (res.status !== 200) return `${path} 状态码 ${res.status}`;
        if (!(res.headers.get('content-type') ?? '').includes(type)) return `${path} content-type 是 ${res.headers.get('content-type')}`;
        if (size < 1_000) return `${path} 只有 ${size} 字节`;
      }
      return null;
    },
  },
  { name: '生成接口：无效链接 → 400 invalid_url', run: () => expectError('/api/generations', json({ url: 'not a url', instructions: '' }), 400, 'invalid_url') },
  { name: '生成接口：非 JSON → 400 invalid_request', run: () => expectError('/api/generations', { method: 'POST', body: '{' }, 400, 'invalid_request') },
  { name: '生成接口：GET → 405 method_not_allowed', run: () => expectError('/api/generations', { method: 'GET' }, 405, 'method_not_allowed') },
  {
    name: '5W1H 接口：不存在的生成 → 404 generation_not_found',
    run: () => expectError(`/api/generations/${UNKNOWN_ID}/chapters/1/summary`, { method: 'POST' }, 404, 'generation_not_found'),
  },
  {
    name: '5W1H 接口：带请求体 → 400 body_not_allowed',
    run: () => expectError(`/api/generations/${UNKNOWN_ID}/chapters/1/summary`, json({ article: 'x' }), 400, 'body_not_allowed'),
  },
  { name: '未知接口 → 404 not_found', run: () => expectError('/api/unknown', { method: 'POST' }, 404, 'not_found') },
];

let failed = 0;
console.log(`冒烟检查：${base}`);
for (const check of checks) {
  let problem: string | null;
  try {
    problem = await check.run();
  } catch (err) {
    problem = `请求失败：${(err as Error).message}`;
  }
  if (problem) failed++;
  console.log(`${problem ? '✗' : '✓'} ${check.name}${problem ? `：${problem}` : ''}`);
}
console.log(failed ? `${failed} 项失败` : `全部 ${checks.length} 项通过`);
process.exit(failed ? 1 : 0);
