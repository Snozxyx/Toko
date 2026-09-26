/**
 * Weebcentral — https://weebcentral.com
 *
 * Cloudflare-fronted and HTMX-driven: search, the full chapter list and the
 * chapter images each come from a small server-rendered fragment endpoint. All
 * requests go through `fetchTextWithBypass`, which clears the Cloudflare
 * challenge in a real browser once and replays the session thereafter.
 *
 * No AniList id — mapping is fuzzy title match via the shared resolver. Reader
 * images want a `Referer`, carried on each page for the local proxy to replay.
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

const BASE = 'https://weebcentral.com';
const PROVIDER_NAME = 'weebcentral';
const IMAGE_HEADERS = { Referer: `${BASE}/` };

interface WcCandidate {
  id: string;
  name: string;
}

function seriesId(href: string): string {
  const m = href.match(/\/series\/([^/?#]+)/);
  return m ? m[1] : '';
}

async function search(query: string): Promise<WcCandidate[]> {
  const url =
    `${BASE}/search/data?text=${encodeURIComponent(query)}` +
    `&sort=Best+Match&order=Descending&official=Any&anime=Any&adult=Any&display_mode=Full+Display`;
  const html = await fetchTextWithBypass(url, { timeoutMs: 15000 });
  if (!html) return [];
  const $ = loadHtml(html);

  const byId = new Map<string, WcCandidate>();
  $('a[href*="/series/"]').each((_, el) => {
    const id = seriesId($(el).attr('href') || '');
    const name = $(el).text().trim();
    if (!id || !name) return;
    if (!byId.has(id)) byId.set(id, { id, name });
  });
  return Array.from(byId.values());
}

function chapterNumber(text: string): number {
  const m = text.match(/chapter\s*([\d.]+)/i);
  if (m) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const titles = await resolveMangaTitles(params);
      if (titles.length === 0) return [];

      const pool: WcCandidate[] = [];
      const seen = new Set<string>();
      for (const title of titles.slice(0, 2)) {
        for (const c of await search(title)) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            pool.push(c);
          }
        }
      }

      const best = pickBestMangaCandidate(titles, pool, (c) => [c.name], 0.6);
      if (!best) return [];

      const html = await fetchTextWithBypass(
        `${BASE}/series/${best.candidate.id}/full-chapter-list`,
        { timeoutMs: 15000 },
      );
      if (!html) return [];
      const $ = loadHtml(html);

      const byNumber = new Map<number, MangaChapterEntry>();
      $('a[href*="/chapters/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/chapters\/([^/?#]+)/);
        if (!m) return;
        const num = chapterNumber($(el).text().trim());
        if (!Number.isFinite(num) || byNumber.has(num)) return;

        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${m[1]}`,
          providerChapterId: m[1],
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
      const chapterId = colonIdx >= 0 ? chapterKey.slice(colonIdx + 1) : chapterKey;
      if (!chapterId) return [];

      const html = await fetchTextWithBypass(
        `${BASE}/chapters/${chapterId}/images?is_prev=False&reading_style=long_strip`,
        { timeoutMs: 20000 },
      );
      if (!html) return [];
      const $ = loadHtml(html);

      const pages: MangaPageEntry[] = [];
      $('img').each((_, el) => {
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
