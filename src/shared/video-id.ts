const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const PATH_ID = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/;

/** 从 YouTube 链接中取出 11 位视频 ID，不是 YouTube 视频链接时返回 null。 */
export function parseVideoId(input: string): string | null {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;

  const id =
    host === 'youtu.be'
      ? url.pathname.split('/')[1]
      : url.pathname === '/watch'
        ? url.searchParams.get('v')
        : PATH_ID.exec(url.pathname)?.[1];
  return id && VIDEO_ID.test(id) ? id : null;
}
