import { AppError, errorResponse, toAppError } from './app-error';
import { handleGenerate } from './generate';
import { handleSummary } from './summary';

export { GenerationStore } from './store';
export { TranscriptRelay } from './transcript-relay';

const SUMMARY_ROUTE = /^\/api\/generations\/([^/]+)\/chapters\/([^/]+)\/summary$/;

/** 静态页面由 Workers Assets 直接返回，只有 /api/* 和未命中的路径会进到这里。 */
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/generations') {
        requirePost(request);
        return await handleGenerate(request, env, ctx);
      }
      const summary = SUMMARY_ROUTE.exec(pathname);
      if (summary) {
        requirePost(request);
        return await handleSummary(request, env, decodeURIComponent(summary[1]!), decodeURIComponent(summary[2]!));
      }
      throw new AppError('not_found');
    } catch (err) {
      const error = toAppError(err);
      if (error.code === 'internal') console.error(err);
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;

function requirePost(request: Request): void {
  if (request.method !== 'POST') throw new AppError('method_not_allowed');
}
