/**
 * Nelomanga — https://www.nelomanga.com (Mangakakalot / Manganato family)
 *
 * Cloudflare-gated server-rendered HTML. Search, the detail chapter list and
 * the chapter reader are plain pages fetched through `fetchTextWithBypass`,
 * which clears the challenge in a real browser once and replays the session.
 *
 * No AniList id — mapping is fuzzy title match via the shared resolver. Reader
 * images sit on the site's own CDN behind a hotlink check, so each page carries
 * a `Referer` for the local proxy to replay.
 */
import type {
  MangaProvider,
  MangaChapterEntry,
  MangaChapterParams,
  MangaChapterSource,
  MangaPageEntry,
} from '../../types/index.js';

import { loadHtml } from '../../utils/http/fetch.js';
import { fetchTextWithBypass } from '../../utils/common/fetch-bypass.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://www.nelomanga.com';
const PROVIDER_NAME = 'nelomanga';
const IMAGE_HEADERS = { Referer: `${BASE}/` };

interface NlCandidate {
  url: string; // absolute detail URL /manga/<slug>
  name: string;
}

/** /manga/<slug> — a detail URL has exactly one segment after /manga/. */
function isDetailUrl(url: string): boolean {
  try {
    const parts = new URL(url).pathname.replace(/^\/|\/$/g, '').split('/');
    return parts[0] === 'manga' && parts.length === 2;
  } catch {
    return false;
  }
}

async function search(query: string): Promise<NlCandidate[]> {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) return [];
  const html = await fetchTextWithBypass(`${BASE}/search/story/${slug}`, { timeoutMs: 15000 });
  if (!html) return [];
  const $ = loadHtml(html);

  const byUrl = new Map<string, NlCandidate>();
  $('.story_item a[href*="/manga/"], .list-truyen-item-wrap a[href*="/manga/"], h3 a[href*="/manga/"]').each((_, el) => {
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
  return Array.from(byUrl.values());
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const titles = await resolveMangaTitles(params);
      if (titles.length === 0) return [];

      const pool: NlCandidate[] = [];
      const seen = new Set<string>();
      for (const title of titles.slice(0, 2)) {
        for (const c of await search(title)) {
          if (!seen.has(c.url)) {
            seen.add(c.url);
            pool.push(c);
          }
        }
      }

      const best = pickBestMangaCandidate(titles, pool, (c) => [c.name], 0.6);
      if (!best) return [];
      const detailUrl = best.candidate.url.replace(/\/$/, '');

      const html = await fetchTextWithBypass(detailUrl, { timeoutMs: 15000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const byNumber = new Map<number, MangaChapterEntry>();
      $('a[href*="/manga/"]').each((_, el) => {
        const raw = $(el).attr('href') || '';
        let chUrl: string;
        try {
          chUrl = new URL(raw, BASE).toString().replace(/\/$/, '');
        } catch {
          return;
        }
        if (!chUrl.startsWith(`${detailUrl}/`)) return;
        const m = chUrl.match(/chapter-([\d.]+)/i);
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

      const html = await fetchTextWithBypass(url, { timeoutMs: 20000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const pages: MangaPageEntry[] = [];
      $('.container-chapter-reader img, .container-chapter-reader-inner img').each((_, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src') || '';
        if (src.startsWith('http')) {
          pages.push({ pageNumber: pages.length + 1, imageUrl: src, headers: IMAGE_HEADERS });
        }
      });
      return pages;
    } catch {
      return [];
    }
  },
};

export default provider;
