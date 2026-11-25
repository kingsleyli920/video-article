import { ERROR_MESSAGES } from '../shared/errors';
import { LIMITS } from '../shared/limits';
import type { StreamEvents } from '../shared/types';
import { parseVideoId } from '../shared/video-id';
import { createArticleView, numberWarningText } from './article-view';
import { runGeneration, type GenerationStage, type GenerationUi } from './generation';
import { bindSummaries } from './summary-panel';

interface GenerationInput {
  url: string;
  instructions: string;
}

type Tone = 'busy' | 'ok' | 'error' | 'idle';

const SAMPLE_URL = 'https://www.youtube.com/watch?v=xRh2sVcNXQ8';
const STAGE_TEXT: Record<GenerationStage, string> = {
  transcript: '正在获取字幕',
  waiting: '字幕已获取，等待模型输出',
  writing: '正在生成文章',
};

const form = byId<HTMLFormElement>('generate-form');
const urlInput = byId<HTMLInputElement>('video-url');
const instructionsInput = byId<HTMLTextAreaElement>('instructions');
const sampleButton = byId<HTMLButtonElement>('fill-sample');
const submitButton = byId<HTMLButtonElement>('submit');
const stopButton = byId<HTMLButtonElement>('stop');
const statusBox = byId<HTMLDivElement>('status');
const articleRoot = byId<HTMLElement>('article');

const view = createArticleView(articleRoot);
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

  // 状态条每秒刷新：当前阶段 + 已用时间（不显示没有依据的进度百分比）
  const startedAt = Date.now();
  const seconds = () => Math.round((Date.now() - startedAt) / 1000);
  let stage: GenerationStage = 'transcript';
  let source = '';
  let requestedModel = '';
  const renderProgress = () => showStatus('busy', `${STAGE_TEXT[stage]} · 已用时 ${seconds()} 秒`, source);
  const ticker = setInterval(renderProgress, 1_000);
  renderProgress();

  const ui: GenerationUi = {
    stage(next) {
      stage = next;
      renderProgress();
    },
    meta(meta) {
      source = describeSource(meta);
      requestedModel = meta.model;
      renderProgress();
    },
    delta(markdown) {
      view.update(markdown);
    },
    done(result, markdown, generationId) {
      clearInterval(ticker);
      const warnings = result.numberWarnings ?? [];
      view.finish(markdown, warnings.map(numberWarningText));
      unbindSummaries = bindSummaries(articleRoot, generationId);
      const warningText = warnings.length ? `文中有 ${warnings.length} 处数字没有字幕依据，见标题下方的提示。` : '';
      const modelNote = result.model && result.model !== requestedModel ? ` · 主模型繁忙，本次由 ${result.model} 生成` : '';
      showStatus('ok', `已完成，共 ${result.chapters.length} 章、${result.chars} 字，用时 ${seconds()} 秒。${warningText}点击章节标题旁的 5W1H 查看总结。`, source + modelNote);
    },
    fail(error, markdown) {
      clearInterval(ticker);
      const cancelled = error.code === 'cancelled';
      view.fail(markdown, error.message);
      showStatus(cancelled ? 'idle' : 'error', cancelled ? `已停止生成，已生成的内容保留在下方。` : error.message, source, true);
    },
  };

  try {
    await runGeneration(input, ui, { signal: controller.signal });
  } finally {
    clearInterval(ticker);
    running = null;
    setRunning(false);
  }
}

function describeSource({ video, transcript }: StreamEvents['meta']): string {
  const kind = transcript.kind === 'asr' ? '自动生成字幕' : '人工字幕';
  const origin = transcript.source === 'live' ? 'YouTube 实时获取' : `内置备份（实时获取失败：${transcript.liveError ?? '未知原因'}）`;
  return `${video.title} · ${kind}（${transcript.language}）· 来源：${origin}`;
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
