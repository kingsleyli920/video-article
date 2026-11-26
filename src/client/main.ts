import { ERROR_MESSAGES } from '../shared/errors';
import { LIMITS } from '../shared/limits';
import { parseVideoId } from '../shared/video-id';
import { createArticleView, numberWarningText } from './article-view';
import type { Revision, StreamEvents } from '../shared/types';
import { runGeneration, type GenerationStage, type GenerationUi } from './generation';
import { clearArticle, clearPending, loadArticle, markPending, saveArticle, takePending, type GenerationInput } from './saved';
import { createSourcePanel, type SourceMeta } from './source-panel';
import { bindSummaries } from './summary-panel';

type Tone = 'busy' | 'ok' | 'error' | 'idle';

const SAMPLE_URL = 'https://www.youtube.com/watch?v=xRh2sVcNXQ8';
const STAGE_TEXT: Record<GenerationStage, string> = {
  transcript: '正在获取字幕',
  waiting: '字幕已获取，等待模型输出',
  writing: '正在生成文章',
  revising: '正在修订初稿',
  reviewing: '正文已写完，正在对照字幕核对',
};

/** 核对没通过时文章下方的说明用"未通过核对"，其他失败是"内容不完整" */
const REVIEW_ERRORS = new Set(['requirements_unmet', 'requirements_unconfirmed', 'review_failed']);

const form = byId<HTMLFormElement>('generate-form');
const urlInput = byId<HTMLInputElement>('video-url');
const instructionsInput = byId<HTMLTextAreaElement>('instructions');
const sampleButton = byId<HTMLButtonElement>('fill-sample');
const submitButton = byId<HTMLButtonElement>('submit');
const stopButton = byId<HTMLButtonElement>('stop');
const statusBox = byId<HTMLDivElement>('status');
const articleRoot = byId<HTMLElement>('article');

const view = createArticleView(articleRoot);
const sourcePanel = createSourcePanel(byId<HTMLElement>('source'));
let unbindSummaries: (() => void) | null = null;
let lastInput: GenerationInput | null = null;
let running: AbortController | null = null;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void generate({ url: urlInput.value.trim(), instructions: instructionsInput.value.trim() });
});
// 只填链接，不自动生成
sampleButton.addEventListener('click', () => {
  urlInput.value = SAMPLE_URL;
  urlInput.focus();
});
stopButton.addEventListener('click', () => running?.abort());
// 生成中刷新或关闭页面会断开连接，这次生成随之停止、不保存：先让浏览器问一句
window.addEventListener('beforeunload', (event) => {
  if (!running) return;
  event.preventDefault();
  event.returnValue = '';
});
restore();

async function generate(input: GenerationInput): Promise<void> {
  if (running) return;
  if (!parseVideoId(input.url)) {
    showStatus('error', ERROR_MESSAGES.invalid_url);
    urlInput.focus();
    return;
  }
  if (input.instructions.length > LIMITS.instructionsChars) {
    showStatus('error', ERROR_MESSAGES.instructions_too_long);
    return;
  }

  const controller = new AbortController();
  running = controller;
  lastInput = input;
  setRunning(true);
  unbindSummaries?.();
  unbindSummaries = null;
  view.reset();
  sourcePanel.clear();
  // 页面上不再是上一篇文章：清掉本地保存的那篇，并记下这次的输入，刷新后能说明"上次被打断"
  clearArticle();
  markPending(input);
  let sourceMeta: SourceMeta | null = null;

  // 状态条每秒刷新：当前阶段 + 已用时间（不显示没有依据的进度百分比）
  const startedAt = Date.now();
  const seconds = () => Math.round((Date.now() - startedAt) / 1000);
  let stage: GenerationStage = 'transcript';
  let requestedModel = '';
  // 视频和字幕的来源只写在来源面板里，状态条只管阶段、用时和结果
  const renderProgress = () => showStatus('busy', `${STAGE_TEXT[stage]} · 已用时 ${seconds()} 秒`);
  const ticker = setInterval(renderProgress, 1_000);
  renderProgress();

  const ui: GenerationUi = {
    stage(next) {
      stage = next;
      if (next === 'revising' || next === 'reviewing') view.settle();
      renderProgress();
    },
    meta(meta) {
      sourcePanel.show(meta);
      sourceMeta = { video: meta.video, transcript: meta.transcript };
      requestedModel = meta.model;
    },
    delta(markdown) {
      view.update(markdown);
    },
    done(result, markdown, generationId, revisions) {
      clearInterval(ticker);
      const modelNote = result.model && result.model !== requestedModel ? `主模型繁忙，本次由 ${result.model} 生成` : '';
      showCompleted(result, markdown, generationId, revisions, `已完成，共 ${result.chapters.length} 章、${result.chars.toLocaleString('en-US')} 字，用时 ${seconds()} 秒。`, modelNote);
      clearPending();
      saveArticle({ input, generationId, markdown, meta: sourceMeta, done: result, revisions });
    },
    fail(error, markdown) {
      clearInterval(ticker);
      const cancelled = error.code === 'cancelled';
      // 核对阶段点了停止：正文其实已经写完，缺的是核对和保存，不说成"内容不完整"
      const stoppedInReview = cancelled && (stage === 'revising' || stage === 'reviewing');
      view.fail(markdown, stoppedInReview ? '已停止，这篇文章没有核对完，也没有保存' : error.message, REVIEW_ERRORS.has(error.code) || stoppedInReview ? '未通过核对' : '内容不完整');
      const stoppedText = stoppedInReview ? '已停止，下方是没有核对完的初稿。' : markdown ? '已停止生成，已生成的内容保留在下方。' : '已停止生成。';
      showStatus(cancelled ? 'idle' : 'error', cancelled ? stoppedText : error.message, '', true);
      clearPending();
    },
  };

  try {
    await runGeneration(input, ui, { signal: controller.signal });
  } finally {
    clearInterval(ticker);
    clearPending();
    running = null;
    // 停止按钮马上要隐藏，焦点还在它上面时移到"生成文章"，键盘用户不会丢失位置
    const stopHadFocus = document.activeElement === stopButton;
    setRunning(false);
    if (stopHadFocus) submitButton.focus();
  }
}

/** 显示一篇已经保存的文章：正文、核对记录、可用的 5W1H 和状态条。刚生成完和刷新后恢复共用 */
function showCompleted(result: StreamEvents['done'], markdown: string, generationId: string, revisions: Revision[], lead: string, detail = ''): void {
  const warnings = result.numberWarnings ?? [];
  view.finish(markdown, warnings.map(numberWarningText), result.review ? { review: result.review, revisions } : undefined);
  unbindSummaries?.();
  unbindSummaries = bindSummaries(articleRoot, generationId);
  const warningText = warnings.length ? `文中有 ${warnings.length} 处疑似补全了残缺数字，见标题下方的提示。` : '';
  const reviewText = result.review ? (result.review.revisions ? `已对照字幕核对，修订 ${result.review.revisions} 处。` : '已对照字幕核对。') : '';
  showStatus('ok', `${lead}${reviewText}${warningText}点击章节标题旁的 5W1H 查看总结。`, detail);
}

/**
 * 页面打开时的恢复。上次生成被刷新或关闭打断：把输入填回去并说明没有保存。
 * 否则，有上次完成的文章就原样显示出来。
 */
function restore(): void {
  const interrupted = takePending();
  if (interrupted) {
    urlInput.value = interrupted.url;
    instructionsInput.value = interrupted.instructions;
    lastInput = interrupted;
    showStatus('idle', '上次生成因为页面刷新或关闭而中断，没有保存。链接和要求已经填回。', '', true);
    return;
  }
  const saved = loadArticle();
  if (!saved) return;
  urlInput.value = saved.input.url;
  instructionsInput.value = saved.input.instructions;
  lastInput = saved.input;
  if (saved.meta) sourcePanel.show(saved.meta);
  const when = new Date(saved.savedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  showCompleted(saved.done, saved.markdown, saved.generationId, saved.revisions, `已恢复上次生成的文章（${when} 完成），共 ${saved.done.chapters.length} 章、${saved.done.chars.toLocaleString('en-US')} 字。`);
}

function showStatus(tone: Tone, text: string, detail = '', withRetry = false): void {
  const main = document.createElement('span');
  main.className = 'status-text';
  main.textContent = text;
  if (detail) {
    const small = document.createElement('span');
    small.className = 'status-detail';
    small.textContent = detail;
    main.append(small);
  }
  const children: Node[] = [main];
  if (withRetry && lastInput) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'link-button';
    retry.textContent = '重新生成';
    const input = lastInput;
    retry.addEventListener('click', () => void generate(input));
    children.push(retry);
  }
  statusBox.replaceChildren(...children);
  statusBox.dataset.tone = tone;
  // 生成中每秒刷新一次已用时间，不让读屏软件每秒播报；完成、失败、停止这些结果照常播报
  statusBox.setAttribute('aria-live', tone === 'busy' ? 'off' : 'polite');
  statusBox.hidden = false;
}

function setRunning(isRunning: boolean): void {
  for (const control of [urlInput, instructionsInput, submitButton, sampleButton]) control.disabled = isRunning;
  submitButton.textContent = isRunning ? '生成中…' : '生成文章';
  stopButton.hidden = !isRunning;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`页面缺少 #${id}`);
  return element as T;
}
