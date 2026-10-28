import type { NovelProvider, NovelChapterEntry } from '../../types/index.js';
import { loadHtml } from '../../utils/http/fetch.js';
import { fetchNovelSearchHtml } from './novel-http.js';
const BASE = 'https://www.scribblehub.com';
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
function safeUrl(value: string) {
  const url = new URL(value, BASE);
  if (url.origin !== BASE || url.username || url.password || url.hash) throw new Error('Invalid Scribble Hub URL');
  return url;
}
const provider: NovelProvider = {
  name: 'scribblehub', sites: [BASE],
  async search(query) {
    const $ = loadHtml(await fetchNovelSearchHtml(`${BASE}/?s=${encodeURIComponent(query)}&post_type=fictionposts`));
    const found = new Map<string, { id: string; title: string; url: string }>();
    $('.search_title > a[href]').each((_, node) => {
      let url: URL; try { url = safeUrl($(node).attr('href') || ''); } catch { return; }
      if (!/^\/series\/\d+\/[^/]+\/?$/.test(url.pathname)) return;
      const title = clean($(node).text());
      if (title) found.set(url.href, { id: url.href, title, url: url.href });
    });
    return [...found.values()];
  },
  async getChapters(params): Promise<NovelChapterEntry[]> {
    if (!params.seriesId) return [];
    const series = safeUrl(params.seriesId);
    const match = series.pathname.match(/^\/series\/(\d+)\/[^/]+\/?$/);
    if (!match) return [];
    const body = new URLSearchParams({ action: 'wi_getreleases_pagination', pagenum: '-1', mypostid: match[1] });
    const $ = loadHtml(await fetchNovelSearchHtml(`${BASE}/wp-admin/admin-ajax.php`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: series.href }, body: body.toString(),
    }));
    const links = new Map<string, { url: string; title: string }>();
    $('.toc_w .toc_a[href]').each((_, node) => {
      let url: URL; try { url = safeUrl($(node).attr('href') || ''); } catch { return; }
      if (!url.pathname.startsWith(`/read/${match[1]}/`) || !/\/chapter\/\d+\/?$/.test(url.pathname)) return;
      links.set(url.href, { url: url.href, title: clean($(node).text()) });
    });
    // Scribble Hub returns newest first; ordinal order also preserves prologues and side chapters.
    return [...links.values()].reverse().map((chapter, index) => ({ number: index + 1, title: chapter.title || null, volume: null,
      sources: [{ provider: 'scribblehub', providerName: 'Scribble Hub', chapterKey: `scribblehub:${encodeURIComponent(chapter.url)}`,
        providerChapterId: chapter.url, language: 'en', translator: null, releaseDate: null }] }));
  },
  async getContent(key) {
    if (!key.startsWith('scribblehub:')) return null;
    const url = safeUrl(decodeURIComponent(key.slice('scribblehub:'.length)));
    if (!/^\/read\/\d+\/[^/]+\/chapter\/\d+\/?$/.test(url.pathname)) return null;
    const $ = loadHtml(await fetchNovelSearchHtml(url.href));
    const body = $('.chp_raw').first();
    body.find('script,style,iframe,.wi_authornotes,.adsbygoogle').remove();
    const paragraphs: string[] = [];
    body.find('p').each((_, node) => { const text = clean($(node).text()); if (text) paragraphs.push(text); });
    if (!paragraphs.length) { body.find('br').replaceWith('\n'); paragraphs.push(...body.text().split(/\n+/).map(clean).filter(Boolean)); }
    return paragraphs.length ? { provider: 'scribblehub', title: clean($('.chapter-title').first().text()) || null, number: null,
      paragraphs: paragraphs.map((text, index) => ({ text, index })) } : null;
  },
};
export default provider;
