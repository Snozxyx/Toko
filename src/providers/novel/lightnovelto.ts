/**
 * LightNovel.to — https://lightnovel.to
 *
 * Plain server-rendered light-novel catalogue:
 *   - search   → `/search?query=<q>` (fallback: `/search/<q>`); cards link to
 *                `/novel/<slug>` or `/series/<slug>`.
 *   - chapters → series page chapter anchors `a[href*="/chapter/"]` /
 *                `.chapter-list a` with dates in `.chapter-time`-ish siblings.
 *   - content  → chapter body `.chapter-content p` / `#chapter-container p`;
 *                plain text, translator-credit lines filtered.
 *
 * No AniList id on-page — fuzzy title match via the shared resolver.
 * best-effort: selectors come from the common catalogue theme; every step
 * degrades to []/null so the reader falls back to the next provider.
 */
import type {
  NovelProvider,
  NovelChapterEntry,
  NovelChapterParams,
  NovelChapterSource,
  NovelContentEntry,
} from '../../types/index.js';

import { fetchText, fetchJson, loadHtml } from '../../utils/http/fetch.js';
import { fetchNovelSearchHtml } from './novel-http.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://lightnovel.to';
const PROVIDER_NAME = 'lightnovelto';

interface LntCandidate {
  href: string;
  name: string;
}

function toUrl(href: string): string {
  return href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
}

async function searchSeries(query: string): Promise<LntCandidate[]> {
  const urls = [
    `${BASE}/search?q=${encodeURIComponent(query)}`,
    `${BASE}/search/${encodeURIComponent(query)}`,
  ];
  const byHref = new Map<string, LntCandidate>();
  for (const url of urls) {
    const html = await fetchNovelSearchHtml(url);
    if (!html) continue;
    const $ = loadHtml(html);
    $('a[href*="/novel/"], a[href*="/series/"], .novel-item a[href], .search-item a[href]').each((_, el) => {
      const a = $(el);
      const href = (a.attr('href') || '').trim();
      if (!href || /chapter/i.test(href) || byHref.has(href)) return;
      const name = (a.attr('title') || a.find('h3, .novel-title').first().text() || a.find('img').attr('alt') || a.text()).trim().replace(/\s+/g, ' ');
      if (!name || name.length < 2) return;
      byHref.set(href, { href, name });
    });
    if (byHref.size > 0) break;
  }
  return Array.from(byHref.values()).slice(0, 20);
}

async function resolveSeriesHref(params: NovelChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;
  const pool: LntCandidate[] = [];
  const seen = new Set<string>();
  for (const title of titles.slice(0, 2)) {
    for (const cand of await searchSeries(title)) {
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
  m = href.match(/chapter[-_/.\s]*(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  m = label.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

function extractParagraphs($: ReturnType<typeof loadHtml>): string[] {
  const selectors = [
    '#chapter-content p',
    '.ln-prose p',
    '.chapter-content p',
    '#chapter-container p',
    '.reading-content p',
    '.novel-content p',
    'article p',
  ];
  for (const sel of selectors) {
    const nodes = $(sel);
    if (nodes.length === 0) continue;
    const out: string[] = [];
    nodes.each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length < 2) return;
      if (/^(translator|editor)\s*:/i.test(text) && text.length < 120) return;
      out.push(text);
    });
    if (out.length >= 2) return out;
  }
  return [];
}

const provider: NovelProvider = {
  name: PROVIDER_NAME,
  sites: ['https://lightnovel.to', 'https://www.lightnovel.to'],
  async search(query) { return (await searchSeries(query)).map(row => ({ id: row.href, title: row.name, url: toUrl(row.href) })); },

  async getChapters(params: NovelChapterParams): Promise<NovelChapterEntry[]> {
    try {
      const href = params.seriesId || await resolveSeriesHref(params);
      if (!href) return [];
      if (new URL(toUrl(href)).origin !== BASE) throw new Error('Invalid LightNovel.to title URL');
      const html = await fetchText(toUrl(href), { timeoutMs: 12000 });
      if (!html) return [];
      const $ = loadHtml(html);
      const byNumber = new Map<number, NovelChapterEntry>();
      const slug = new URL(toUrl(href)).pathname.split('/').filter(Boolean)[1];
      const catalog = await fetchJson<{ chapters?: Array<{ slug: string; number: number; title?: string; createdAt?: string }> } | Array<{ slug: string; number: number; title?: string; createdAt?: string }>>(`${BASE}/api/novel-chapters?slug=${encodeURIComponent(slug)}`, { timeoutMs: 15000 });
      const chapterRows = Array.isArray(catalog) ? catalog : catalog?.chapters || [];
      for (const row of chapterRows) {
        if (!row.slug || !Number.isFinite(Number(row.number)) || !/^chapter-[\w.-]+$/.test(row.slug)) continue;
        const full = `${BASE}/novel/${encodeURIComponent(slug)}/${row.slug}`;
        byNumber.set(Number(row.number), { number: Number(row.number), title: row.title || `Chapter ${row.number}`, volume: null, sources: [{ provider: PROVIDER_NAME, chapterKey: `${PROVIDER_NAME}:${encodeURIComponent(full)}`, providerChapterId: full, language: 'en', translator: null, releaseDate: row.createdAt || null }] });
      }
      let order = 0;
      $('a[href*="/chapter-"], a[href*="/chapter/"], .chapter-list a[href], .chapters a[href], ul.chapter-list a[href]').each((_, el) => {
        const a = $(el);
        const chHref = (a.attr('href') || '').trim();
        if (!chHref) return;
        const label = (a.attr('title') || a.text()).trim().replace(/\s+/g, ' ');
        if (!label) return;
        order += 1;
        const num = parseChapterNumber(label, chHref);
        const n = Number.isFinite(num) ? num : order;
        if (byNumber.has(n)) return;
        const full = toUrl(chHref);
        const date = a.closest('li').find('.chapter-time, .chapter-date, time').first().text().trim() || null;
        const source: NovelChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${encodeURIComponent(full)}`,
          providerChapterId: full,
          language: 'en',
          translator: null,
          releaseDate: date,
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
      if (!url || new URL(toUrl(url)).origin !== BASE) return null;
      const html = await fetchText(url.startsWith('http') ? url : toUrl(url), { timeoutMs: 15000 });
      if (!html) return null;
      const $ = loadHtml(html);
      const title =
        $('h1.chapter-title, .chapter-header h1, h1.entry-title').first().text().trim() ||
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
