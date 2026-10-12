import { fetchTextWithBypass } from '../../utils/common/fetch-bypass.js';
import { fetchResponse } from '../../utils/http/fetch.js';
import type { FetchOptions } from '../../utils/http/fetch.js';
import { getCachedSession } from '../../utils/common/cf-bypass.js';
const pages = new Map<string, { at: number; html: string }>();
const pending = new Map<string, Promise<string>>();
export function clearNovelHttpCache(): void {
  pages.clear();
  pending.clear();
}
export async function fetchNovelSearchHtml(url: string, options: FetchOptions = {}): Promise<string> {
  const headers = new Headers(options.headers);
  const session = getCachedSession(url);
  if (session?.cookie && !headers.has('Cookie')) headers.set('Cookie', session.cookie);
  if (session?.userAgent) headers.set('User-Agent', session.userAgent);
  const cacheable = !options.method || options.method.toUpperCase() === 'GET';
  const key = JSON.stringify([url,[...headers.entries()].sort()]);
  const ttl = new URL(url).pathname === '/translations/' ? 15 * 60000 : 60000;
  const hit = cacheable ? pages.get(key) : undefined;
  if (hit && Date.now() - hit.at < ttl) return hit.html;
  const running = cacheable ? pending.get(key) : undefined;
  if (running) return running;
  const request = fetchPage(url, { ...options, headers }).then(html => {
    if (cacheable && html.length < 2 * 1024 * 1024) {
      pages.set(key, {at:Date.now(),html});
      if (pages.size > 40) pages.delete(pages.keys().next().value!);
    }
    return html;
  }).finally(()=>pending.delete(key));
  if (cacheable) pending.set(key, request);
  return request;
}
async function fetchPage(url: string, options: FetchOptions): Promise<string> {
  // The native proxy may spend up to 45s earning clearance on first contact.
  // A 12s abort would discard its answer on Android/iOS before it could finish.
  const timeoutMs = (process as any).browser ? 55000 : options.timeoutMs ?? 12000;
  const response = await fetchResponse(url, { ...options, timeoutMs });
  const html = await fetchTextWithBypass(url, {
    response,
    method: options.method,
    body: typeof options.body === 'string' ? options.body : undefined,
    headers: Object.fromEntries(new Headers(options.headers).entries()),
    timeoutMs,
    bypassTimeoutMs: 15000,
  });
  if (html) return html;
  throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}${response.status === 403 ? ' (access blocked)' : response.ok ? ' (challenge page or unreadable response)' : ''}`);
}
