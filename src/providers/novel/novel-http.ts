import { fetchResponse } from '../../utils/http/fetch.js';
export async function fetchNovelSearchHtml(url: string): Promise<string> {
  const response = await fetchResponse(url, { timeoutMs: 12000 });
  if (!response.ok) throw new Error(`${new URL(url).hostname} search returned HTTP ${response.status}${response.status === 403 ? ' (access blocked)' : ''}`);
  return response.text();
}
