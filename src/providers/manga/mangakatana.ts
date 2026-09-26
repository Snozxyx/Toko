/**
 * Mangakatana — https://mangakatana.com
 *
 * Server-rendered HTML on nginx, no Cloudflare. Search lists book cards (or
 * redirects straight to the detail page when there is a single hit), the detail
 * page lists every chapter, and each chapter page embeds its image URLs in an
 * inline `var thzq = [ ... ]` array on `i*.mangakatana.com` (token-signed, so
 * pages carry a `Referer`).
 *
 * No AniList id anywhere — mapping is fuzzy title match via the shared resolver.
 */
import type {
  MangaProvider,
  MangaChapterEntry,
  MangaChapterParams,
  MangaChapterSource,
  MangaPageEntry,
} from '../../types/index.js';

import { fetchText, loadHtml } from '../../utils/http/fetch.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://mangakatana.com';
const PROVIDER_NAME = 'mangakatana';
const IMAGE_HEADERS = { Referer: `${BASE}/` };

interface MkCandidate {
  url: string; // absolute detail URL, /manga/<slug>.<id>
  name: string;
}

/** A detail URL has exactly one path segment after /manga/ ( <slug>.<id> ). */
function isDetailUrl(url: string): boolean {
  try {
    const parts = new URL(url).pathname.replace(/^\/|\/$/g, '').split('/');
    return parts[0] === 'manga' && parts.length === 2;
  } catch {
    return false;
  }
}

/**
 * Scrape the search page. Returns {candidates} normally, or {direct} when the
 * search collapsed to a single manga and mangakatana served the detail page.
 */
async function search(query: string): Promise<{ candidates: MkCandidate[]; directHtml?: string; directUrl?: string }> {
  const html = await fetchText(
    `${BASE}/?search=${encodeURIComponent(query)}&search_by=book_name`,
    { timeoutMs: 12000 },
  );
  if (!html) return { candidates: [] };
  const $ = loadHtml(html);

  const byUrl = new Map<string, MkCandidate>();
  $('#book_list .item .title a, #book_list .item h3 a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const name = $(el).text().trim();
    if (!href || !name) return;
    try {
      const url = new URL(href, BASE).toString();
      if (isDetailUrl(url) && !byUrl.has(url)) byUrl.set(url, { url, name });
    } catch {
      /* ignore */
    }
  });

  if (byUrl.size > 0) return { candidates: Array.from(byUrl.values()) };

  // Single-result redirect: mangakatana returned the manga page itself.
  const heading = $('h1.heading').first().text().trim();
  const canonical = $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content') || '';
  if (heading && canonical && isDetailUrl(canonical)) {
    return { candidates: [{ url: canonical, name: heading }], directHtml: html, directUrl: canonical };
  }
  return { candidates: [] };
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const titles = await resolveMangaTitles(params);
      if (titles.length === 0) return [];

      const pool: MkCandidate[] = [];
      const seen = new Set<string>();
      let cachedDetail: { url: string; html: string } | null = null;
      for (const title of titles.slice(0, 2)) {
        const { candidates, directHtml, directUrl } = await search(title);
        if (directHtml && directUrl) cachedDetail = { url: directUrl, html: directHtml };
        for (const c of candidates) {
          if (!seen.has(c.url)) {
            seen.add(c.url);
            pool.push(c);
          }
        }
      }

      const best = pickBestMangaCandidate(titles, pool, (c) => [c.name], 0.6);
      if (!best) return [];
      const detailUrl = best.candidate.url;

      const html =
        cachedDetail && cachedDetail.url === detailUrl
          ? cachedDetail.html
          : await fetchText(detailUrl, { timeoutMs: 12000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const base = detailUrl.replace(/\/$/, '');
      const byNumber = new Map<number, MangaChapterEntry>();
      $('a[href*="/manga/"]').each((_, el) => {
        const raw = $(el).attr('href') || '';
        let chUrl: string;
        try {
          chUrl = new URL(raw, BASE).toString().replace(/\/$/, '');
        } catch {
          return;
        }
        // Chapters live under this manga's own detail URL, as /c<num>.
        if (!chUrl.startsWith(`${base}/c`)) return;
        const m = chUrl.match(/\/c([\d.]+)(?:\/|$)/);
        if (!m) return;
        const num = parseFloat(m[1]);
        if (!Number.isFinite(num) || byNumber.has(num)) return;

        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${chUrl}`,
          providerChapterId: chUrl,
          language: 'en',
          scanlator: null,
          releaseDate: null,
        };
        byNumber.set(num, { number: num, title: null, volume: null, sources: [source] });
      });

      return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  },

  async getPages(chapterKey: string): Promise<MangaPageEntry[]> {
    try {
      const colonIdx = chapterKey.indexOf(':');
      const url = colonIdx >= 0 ? chapterKey.slice(colonIdx + 1) : chapterKey;
      if (!url.startsWith('http')) return [];

      const html = await fetchText(url, { timeoutMs: 15000 });
      if (!html) return [];

      // Images live in an inline `var thzq = ['url', 'url', ...]`.
      const arr = html.match(/var\s+thzq\s*=\s*(\[[^\]]*\])/);
      if (!arr) return [];
      const urls = arr[1].match(/'(https?:\/\/[^']+)'/g);
      if (!urls) return [];

      return urls
        .map((q) => q.slice(1, -1))
        .filter((u) => u.startsWith('http'))
        .map((imageUrl, idx) => ({ pageNumber: idx + 1, imageUrl, headers: IMAGE_HEADERS }));
    } catch {
      return [];
    }
  },
};

export default provider;
