/**
 * 只跑合并处理这一步（真实模型，请求很小）：给一篇文章和一条"疑似会和上下文重复"的建议，看模型给出的结论，
 * 再用生产的校验把结论落实一遍。用来验证合并处理的提示词在这类建议上的实际表现。
 *   tsx scripts/reconcile-probe.ts <文章.md> <建议.json：{type,quote,replacement,evidence,problem}> [次数]
 */
import { readFileSync } from 'node:fs';
import { generateJson } from '../src/worker/gemini';
import { applyRevisionAt, parseReconcile, reconcilePrompt, RECONCILE_SCHEMA, type ReviewIssue } from '../src/worker/review';
import { readEnvFile } from './lib/env-file';

const [articlePath, issuePath, times = '1'] = process.argv.slice(2);
const article = readFileSync(articlePath!, 'utf8');
const issue = JSON.parse(readFileSync(issuePath!, 'utf8')) as ReviewIssue;
const video = { id: 'probe', title: '', channel: '', description: '', lengthSeconds: 0 };
const gemini = { apiKey: readEnvFile('.env').GEMINI_API_KEY!, model: 'gemini-4-hydrogen', thinkingLevel: 'high', timeouts: { requestMs: 300_000 } };
for (let i = 0; i < Number(times); i++) {
  const raw = await generateJson(gemini, reconcilePrompt({ video, article, applied: [], pending: [{ ...issue, failure: 'duplicates_context' }] }), RECONCILE_SCHEMA, {});
  const item = parseReconcile(raw, 1)?.[0];
  if (!item) {
    console.log(`第 ${i + 1} 次：结论无效`, JSON.stringify(raw).slice(0, 200));
    continue;
  }
  console.log(`第 ${i + 1} 次：${item.status}｜${item.note}`);
  if (item.status !== 'revise') continue;
  const at = article.indexOf(item.quote);
  const out = at < 0 ? { reason: 'quote_not_found' } : applyRevisionAt(article, { ...issue, quote: item.quote, replacement: item.replacement, evidence: item.evidence.trim() || issue.evidence }, at, issue.evidence, { allowContextRepeat: true });
  console.log(`  quote：${item.quote}\n  改成：${item.replacement}`);
  if ('reason' in out) console.log(`  落实失败：${out.reason}`);
  else {
    const start = Math.max(0, at - 30);
    console.log(`  落实后：…${out.markdown.slice(start, at + item.replacement.length + 40).replace(/\n/g, ' ')}…`);
  }
}
