/**
 * WebNovel — https://www.webnovel.com
 *
 * Official Qidian international catalogue (huge EN-translated + original
 * library). No AniList id on-page, so mapping is fuzzy title match via the
 * shared resolver (AniList MANGA titles → WebNovel search hits).
 *
 * Shapes (server-rendered + embedded JSON, no auth):
 *   - search   → `/search?keywords=<query>`; result cards are
 *                `.search-result-item` / `a[href*="/book/"]` with the numeric
 *                book id in `/book/<slug>_<bookId>/`.
 *   - chapters → book page `/book/<slug>_<bookId>/` embeds
 *                `window.__NEXT_DATA__` with the chapter list; fallback scrapes
 *                `.chapter-list a[href*="/chapter/"]` / `.volume-item`.
 *   - content  → chapter page `/book/<slug>_<bookId>/<chapterSlug>_<chapterId>`
 *                renders paragraphs in `.chapter-content p` /
 *                `[class*="cha-words"] p`. Paragraphs are plain text (`<br>`
 *                normalised to paragraph breaks).
 *
 * best-effort: WebNovel ships as a Next.js SPA and the markup drifts; every
 * step has an HTML fallback and returns []/null instead of throwing so the
 * reader's cross-source fallback can try the next provider.
 */
import type {
  NovelProvider,
  NovelChapterEntry,
  NovelChapterParams,
  NovelChapterSource,
  NovelContentEntry,
} from '../../types/index.js';

import { fetchJsonWithBypass } from '../../utils/common/fetch-bypass.js';
import { fetchText, loadHtml } from '../../utils/http/fetch.js';
import { fetchNovelSearchHtml } from './novel-http.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://www.webnovel.com';
const PROVIDER_NAME = 'webnovel';

interface WnCandidate {
  bookId: string;
  name: string;
}

function bookUrl(bookId: string): string {
  return `${BASE}/book/${bookId}`;
}

async function searchBooks(query: string): Promise<WnCandidate[]> {
  const html = await fetchNovelSearchHtml(`${BASE}/search?keywords=${encodeURIComponent(query)}`);
  if (!html) return [];
  const $ = loadHtml(html);
  const byId = new Map<string, WnCandidate>();

  // Primary: search result cards linking to /book/.
  $('a[href*="/book/"]').each((_, el) => {
    const a = $(el);
    const href = (a.attr('href') || '').trim();
    const m = href.match(/\/book\/[^/]*?(\d{6,})/);
    if (!m) return;
    const bookId = m[1];
    if (byId.has(bookId)) return;
    const name = (
      a.attr('title') ||
      a.find('img').first().attr('alt') ||
      a.text()
    ).trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2) return;
    byId.set(bookId, { bookId, name });
  });

  return Array.from(byId.values()).slice(0, 20);
}

async function resolveBookId(params: NovelChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;
  const pool: WnCandidate[] = [];
  const seen = new Set<string>();
  for (const title of titles.slice(0, 2)) {
    for (const cand of await searchBooks(title)) {
      if (seen.has(cand.bookId)) continue;
      seen.add(cand.bookId);
      pool.push(cand);
    }
  }
  const best = pickBestMangaCandidate(titles, pool, (c) => [c.name], 0.6);
  return best ? best.candidate.bookId : null;
}

function parseChapterNumber(label: string, href: string): number {
  let m = label.match(/(?:ch(?:apter)?|episode)\.?\s*(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  m = href.match(/(\d+)(?:\/)?$/);
  if (m) {
    const n = parseFloat(m[1]);
    // Guard: WebNovel chapter ids are long numeric ids, not chapter numbers.
    if (n < 100000) return n;
  }
  m = label.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

function cleanParagraphs($: ReturnType<typeof loadHtml>): string[] {
  const out: string[] = [];
  const selectors = [
    '.chapter-content p',
    '[class*="cha-words"] p',
    '.cha-words p',
    '.chapter_content p',
    '#chapter-content p',
    '.content p',
  ];
  for (const sel of selectors) {
    const nodes = $(sel);
    if (nodes.length === 0) continue;
    nodes.each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length < 1) return;
      // Skip UI chrome that sometimes lives inside the content container.
      if (/^(advertisement|chapter \d+|translator|editor):/i.test(text) && text.length < 80) return;
      out.push(text);
    });
    if (out.length > 0) break;
  }
  return out;
}

const provider: NovelProvider = {
  name: PROVIDER_NAME,
  sites: ['https://www.webnovel.com', 'https://webnovel.com'],
  async search(query) { return (await searchBooks(query)).map(row => ({ id: row.bookId, title: row.name, url: bookUrl(row.bookId) })); },

  async getChapters(params: NovelChapterParams): Promise<NovelChapterEntry[]> {
    try {
      const bookId = params.seriesId || await resolveBookId(params);
      if (!bookId) return [];
      if (!/^\d+$/.test(bookId)) throw new Error('Invalid Webnovel book id');

      // Prefer the embedded Next.js payload (full chapter index, paginated API
      // as fallback is rate-limited); scrape the book page HTML.
      const html = await fetchText(bookUrl(bookId), { timeoutMs: 12000 });
      if (!html) return [];
      const $ = loadHtml(html);

      // 1) __NEXT_DATA__ embedded chapter list.
      try {
        const nextData = $('#__NEXT_DATA__').first().text();
        if (nextData) {
          const parsed = JSON.parse(nextData) as any;
          const flat: any[] = [];
          const walk = (node: any) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { for (const v of node) walk(v); return; }
            if (typeof node.chapterId !== 'undefined' && (node.chapterName || node.chapterTitle)) {
              flat.push(node);
              return;
            }
            for (const v of Object.values(node)) walk(v);
          };
          walk(parsed?.props);
          if (flat.length > 0) {
            const byNumber = new Map<number, NovelChapterEntry>();
            let order = 0;
            for (const ch of flat) {
              order += 1;
              const rawName = String(ch.chapterName ?? ch.chapterTitle ?? '');
              const num = parseChapterNumber(rawName, String(ch.chapterId ?? ''));
              const n = Number.isFinite(num) ? num : order;
              if (byNumber.has(n)) continue;
              const chapterId = String(ch.chapterId ?? ch.id ?? '');
              if (!chapterId) continue;
              const source: NovelChapterSource = {
                provider: PROVIDER_NAME,
                chapterKey: `${PROVIDER_NAME}:${bookId}:${chapterId}`,
                providerChapterId: `${bookId}:${chapterId}`,
                language: 'en',
                translator: typeof ch.translatorName === 'string' ? ch.translatorName : null,
                releaseDate: typeof ch.publishTime === 'string' ? ch.publishTime : null,
              };
              byNumber.set(n, { number: n, title: rawName || null, volume: null, sources: [source] });
            }
            if (byNumber.size > 0) return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
          }
        }
      } catch { /* fall through to HTML scrape */ }

      // 2) HTML chapter list fallback.
      const byNumber = new Map<number, NovelChapterEntry>();
      let order = 0;
      $('a[href*="/chapter/"], .chapter-list a, .volume-item a, ol.chapter-list a').each((_, el) => {
        const a = $(el);
        const href = (a.attr('href') || '').trim();
        if (!href) return;
        const label = (a.attr('title') || a.text()).trim().replace(/\s+/g, ' ');
        if (!label) return;
        order += 1;
        const num = parseChapterNumber(label, href);
        const n = Number.isFinite(num) ? num : order;
        if (byNumber.has(n)) return;
        const full = href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
        const idMatch = full.match(/(\d{6,})(?:\/)?$/);
        const chapterId = idMatch ? idMatch[1] : full;
        const source: NovelChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${bookId}:${chapterId}`,
          providerChapterId: `${bookId}:${chapterId}`,
          language: 'en',
          translator: null,
          releaseDate: null,
        };
        byNumber.set(n, { number: n, title: label || null, volume: null, sources: [source] });
      });
      return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  },

  async getContent(chapterKey: string): Promise<NovelContentEntry | null> {
    try {
      const rest = chapterKey.includes(':') ? chapterKey.slice(chapterKey.indexOf(':') + 1) : chapterKey;
      const [bookId, chapterId] = rest.split(':');
      if (!bookId || !chapterId) return null;

      // Chapter URL shape: /book/<bookId>/<anything>_<chapterId> — the slug
      // segment is cosmetic, so the bare id pair resolves via search-page link.
      const html = await fetchText(`${BASE}/book/${bookId}/${chapterId}`, { timeoutMs: 15000 });
      if (!html) return null;
      const $ = loadHtml(html);

      const title =
        $('h1.chapter-title, .chapter-title h1, [class*="cha-tit"]').first().text().trim() ||
        $('title').first().text().trim() ||
        null;

      const texts = cleanParagraphs($);
      if (texts.length === 0) return null;
      return {
        title,
        number: null,
        paragraphs: texts.map((text, index) => ({ index, text })),
        provider: PROVIDER_NAME,
      };
    } catch {
      return null;
    }
  },
};

export default provider;
