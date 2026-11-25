import { ERROR_MESSAGES } from '../shared/errors';
import { LIMITS } from '../shared/limits';
import type { StreamEvents } from '../shared/types';
import { parseVideoId } from '../shared/video-id';
import { ApiError, streamGeneration } from './api';
import { createArticleView } from './article-view';
import { bindSummaries } from './summary-panel';

interface GenerationInput {
  url: string;
  instructions: string;
}

type Tone = 'busy' | 'ok' | 'error';

const form = byId<HTMLFormElement>('generate-form');
const urlInput = byId<HTMLInputElement>('video-url');
const instructionsInput = byId<HTMLTextAreaElement>('instructions');
const submitButton = byId<HTMLButtonElement>('submit');
const statusBox = byId<HTMLDivElement>('status');
const articleRoot = byId<HTMLElement>('article');

const view = createArticleView(articleRoot);
let unbindSummaries: (() => void) | null = null;
let lastInput: GenerationInput | null = null;
let running = false;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void generate({ url: urlInput.value.trim(), instructions: instructionsInput.value.trim() });
});

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

  running = true;
  lastInput = input;
  setFormDisabled(true);
  unbindSummaries?.();
  unbindSummaries = null;
  view.reset();
  showStatus('busy', '正在获取字幕…');

  let markdown = '';
  let generationId = '';
  let source = '';
  let settled = false;
  const fail = (message: string) => {
    settled = true;
    view.fail(markdown, message);
    showStatus('error', message, source, true);
  };

  try {
    for await (const message of streamGeneration(input)) {
      switch (message.event) {
        case 'stage':
          if (message.data.stage === 'generating') showStatus('busy', '正在生成文章…', source);
          break;
        case 'meta':
          generationId = message.data.generationId;
          source = describeSource(message.data);
          showStatus('busy', '字幕已获取，等待模型输出…', source);
          break;
        case 'delta':
          markdown += message.data.text;
          view.update(markdown);
          break;
        case 'done':
          settled = true;
          view.finish(markdown);
          unbindSummaries = bindSummaries(articleRoot, generationId);
          showStatus('ok', `已完成，共 ${message.data.chapters.length} 章。点击章节标题旁的 5W1H 查看总结。`, source);
          break;
        case 'error':
          fail(message.data.message);
          break;
      }
    }
    if (!settled) fail(ERROR_MESSAGES.interrupted);
  } catch (err) {
    fail(err instanceof ApiError ? err.message : ERROR_MESSAGES.network);
  } finally {
    running = false;
    setFormDisabled(false);
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
    retry.textContent = '重试';
    const input = lastInput;
    retry.addEventListener('click', () => void generate(input));
    children.push(retry);
  }
  statusBox.replaceChildren(...children);
  statusBox.dataset.tone = tone;
  statusBox.hidden = false;
}

function setFormDisabled(disabled: boolean): void {
  for (const control of [urlInput, instructionsInput, submitButton]) control.disabled = disabled;
  submitButton.textContent = disabled ? '生成中…' : '生成文章';
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`页面缺少 #${id}`);
  return element as T;
}
