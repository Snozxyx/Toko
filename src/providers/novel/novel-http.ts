import { fetchTextWithBypass } from '../../utils/common/fetch-bypass.js';
import { fetchResponse } from '../../utils/http/fetch.js';
export async function fetchNovelSearchHtml(url: string): Promise<string> {
  const response = await fetchResponse(url, { timeoutMs: 12000 });
  if (response.ok) return response.text();
  const html = await fetchTextWithBypass(url, {
    timeoutMs: 12000,
    bypassTimeoutMs: 12000,
  });
  if (html) return html;
  throw new Error(`${new URL(url).hostname} search returned HTTP ${response.status}${response.status === 403 ? ' (access blocked)' : ''}`);
}
