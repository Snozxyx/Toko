/**
 * JustLightNovels — https://www.justlightnovels.com
 *
 * Light-novel aggregator (WordPress-style catalogue):
 *   - search   → `/?s=<query>` (falls back to `/search/<query>`); result cards
 *                link to the series page (`/novel/...`, `/series/...` or
 *                `/justlightnovels/...` depending on theme version — matched by
 *                "not a chapter link" heuristic).
 *   - chapters → series page lists chapters as `a[href*="chapter"]`
 *                (`.chapter-list`, `.su-accordion`, `.elementor` accordions all
 *                observed across theme versions).
 *   - content  → chapter page body in `.entry-content p` /
 *                `.reading-content p` / `.text-content p`; paragraphs are plain
 *                text with translator credits filtered out.
 *
 * No AniList id on-page — fuzzy title match via the shared resolver.
 * best-effort: theme markup drifts; every step degrades to []/null.
 */
import type {
  NovelProvider,
  NovelChapterEntry,
  NovelChapterParams,
  NovelChapterSource,
  NovelContentEntry,
} from '../../types/index.js';

import { fetchText, loadHtml } from '../../utils/http/fetch.js';
import { fetchNovelSearchHtml } from './novel-http.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://www.justlightnovels.com';
const PROVIDER_NAME = 'justlightnovels';

interface JlnCandidate {
  href: string;
  name: string;
}

function toUrl(href: string): string {
  return href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
}

async function searchSeries(query: string): Promise<JlnCandidate[]> {
  const urls = [
    `${BASE}/?s=${encodeURIComponent(query)}`,
    `${BASE}/search/${encodeURIComponent(query)}`,
  ];
  const byHref = new Map<string, JlnCandidate>();
  let lastSearchError = null;
  for (const url of urls) {
    let html;
    try {
      html = await fetchNovelSearchHtml(url);
    } catch (err) {
      // One search endpoint 403/404ing (WAF, drifted route) must not abort
      // the fallback endpoint — but if every endpoint fails, surface the
      // last error so diagnostics report "access blocked" instead of empty.
      lastSearchError = err;
      continue;
    }
    if (!html) continue;
    const $ = loadHtml(html);
    $('article a[href], .post a[href], .search-results a[href], a.post-title[href]').each((_, el) => {
      const a = $(el);
      const href = (a.attr('href') || '').trim();
      if (!href || !href.startsWith(BASE) && !href.startsWith('/')) return;
      if (/chapter|episode|page/i.test(href)) return;
      const name = (a.attr('title') || a.text()).trim().replace(/\s+/g, ' ');
      if (!name || name.length < 2 || byHref.has(href)) return;
      byHref.set(href, { href, name });
    });
    if (byHref.size > 0) break;
  }
  if (byHref.size === 0 && lastSearchError) throw lastSearchError;
  return Array.from(byHref.values()).slice(0, 20);
}

async function resolveSeriesHref(params: NovelChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;
  const pool: JlnCandidate[] = [];
  const seen = new Set<string>();
  for (const title of titles.slice(0, 2)) {
    let cands = [];
    try {
      cands = await searchSeries(title);
    } catch {
      continue;
    }
    for (const cand of cands) {
      if (seen.has(cand.href)) continue;
      seen.add(cand.href);
      pool.push(cand);
    }
  }
  const best = pickBestMangaCandidate(titles, pool, (c) => [c.name], 0.6);
  return best ? best.candidate.href : null;
}

function parseChapterNumber(label: string, href: string): number {
  let m = label.match(/(?:ch(?:apter)?|part|episode)\.?\s*(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  m = href.match(/chapter[-_.\s]*(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  m = label.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

function extractParagraphs($: ReturnType<typeof loadHtml>): string[] {
  const selectors = [
    '.entry-content p',
    '.reading-content p',
    '.text-content p',
    '.post-content p',
    'article .entry-content p',
  ];
  for (const sel of selectors) {
    const nodes = $(sel);
    if (nodes.length === 0) continue;
    const out: string[] = [];
    nodes.each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length < 2) return;
      if (/^(translator|editor|proofreader)\s*:/i.test(text) && text.length < 120) return;
      if (/^previous|^next|^table of contents/i.test(text) && text.length < 60) return;
      out.push(text);
    });
    if (out.length >= 2) return out;
  }
  return [];
}

const provider: NovelProvider = {
  name: PROVIDER_NAME,
  sites: ['https://www.justlightnovels.com', 'https://justlightnovels.com'],
  async search(query) { return (await searchSeries(query)).map(row => ({ id: row.href, title: row.name, url: toUrl(row.href) })); },

  async getChapters(params: NovelChapterParams): Promise<NovelChapterEntry[]> {
    try {
      const href = params.seriesId || await resolveSeriesHref(params);
      if (!href) return [];
      if (new URL(toUrl(href)).origin !== BASE) throw new Error('Invalid JustLightNovels title URL');
      const html = await fetchText(toUrl(href), { timeoutMs: 12000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const byNumber = new Map<number, NovelChapterEntry>();
      let order = 0;
      $('a[href*="chapter"], .chapter-list a, .su-accordion a[href], .elementor-accordion a[href], .lcp_catlist a[href]').each((_, el) => {
        const a = $(el);
        const chHref = (a.attr('href') || '').trim();
        if (!chHref) return;
        const label = (a.attr('title') || a.text()).trim().replace(/\s+/g, ' ');
        if (!label || label.length < 1) return;
        order += 1;
        const num = parseChapterNumber(label, chHref);
        const n = Number.isFinite(num) ? num : order;
        if (byNumber.has(n)) return;
        const full = toUrl(chHref);
        const source: NovelChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${encodeURIComponent(full)}`,
          providerChapterId: full,
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
      const url = decodeURIComponent(rest);
      if (!url) return null;
      const html = await fetchText(url.startsWith('http') ? url : toUrl(url), { timeoutMs: 15000 });
      if (!html) return null;
      const $ = loadHtml(html);
      const title =
        $('h1.entry-title, h1.post-title, .entry-header h1').first().text().trim() ||
        $('title').first().text().trim() ||
        null;
      const texts = extractParagraphs($);
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
