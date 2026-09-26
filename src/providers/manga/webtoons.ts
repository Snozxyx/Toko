/**
 * Webtoons — https://www.webtoons.com (official LINE Webtoon / NAVER)
 *
 * The official source, so image quality and availability are the best of any
 * manhwa/webtoon provider — it fills the vertical-scroll gap the manga-first
 * catalogues (mangadex/mangapill/…) cover poorly. No Cloudflare, no auth for
 * public titles.
 *
 * Three plain requests, two of them JSON:
 *   - search  → desktop HTML (`/en/search`); cards carry `data-title-no` + title.
 *   - chapters → mobile JSON (`m.webtoons.com/api/v1/webtoon/<no>/episodes`),
 *                cursor-paginated (the `cursor` param is an offset).
 *   - pages   → the episode viewer HTML; images are `img._images[data-url]`.
 *
 * No AniList id in any payload, so mapping is fuzzy title match via the shared
 * resolver. The `pstatic.net` image CDN hotlink-protects, so pages carry a
 * `www.webtoons.com` Referer for the local proxy to replay.
 */
import type {
  MangaProvider,
  MangaChapterEntry,
  MangaChapterParams,
  MangaChapterSource,
  MangaPageEntry,
} from '../../types/index.js';

import { fetchJson, fetchText, loadHtml } from '../../utils/http/fetch.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://www.webtoons.com';
const MOBILE = 'https://m.webtoons.com';
const PROVIDER_NAME = 'webtoons';
const IMAGE_HEADERS = { Referer: `${BASE}/` };
const PAGE_SIZE = 30;
const MAX_EPISODES = 3000; // safety cap so a broken cursor never loops forever

interface WtCandidate {
  titleNo: string;
  title: string;
  author?: string;
}

interface WtEpisode {
  episodeNo?: number;
  episodeTitle?: string;
  viewerLink?: string; // "/en/<genre>/<slug>/<ep>/viewer?title_no=<no>&episode_no=<n>"
  exposureDateMillis?: number;
}

/** Scrape the desktop search page into de-duplicated {titleNo, title} cards. */
async function search(query: string): Promise<WtCandidate[]> {
  const html = await fetchText(`${BASE}/en/search?keyword=${encodeURIComponent(query)}`, { timeoutMs: 12000 });
  if (!html) return [];
  const $ = loadHtml(html);

  const byNo = new Map<string, WtCandidate>();
  // Both Originals (WEBTOON) and Canvas (CHALLENGE) cards share `_card_item`.
  $('a._card_item').each((_, el) => {
    const a = $(el);
    const titleNo = String(a.attr('data-title-no') || '').trim();
    const title = a.find('.title').first().text().trim();
    if (!titleNo || !title || byNo.has(titleNo)) return;
    byNo.set(titleNo, {
      titleNo,
      title,
      author: a.find('.author').first().text().trim() || undefined,
    });
  });
  return Array.from(byNo.values());
}

/** Resolve an AniList id / titles to a Webtoons title_no via fuzzy title match. */
async function resolveTitleNo(params: MangaChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const seen = new Set<string>();
  const pool: WtCandidate[] = [];
  for (const title of titles.slice(0, 2)) {
    for (const cand of await search(title)) {
      if (!seen.has(cand.titleNo)) {
        seen.add(cand.titleNo);
        pool.push(cand);
      }
    }
  }

  const best = pickBestMangaCandidate(titles, pool, (c) => [c.title], 0.6);
  return best ? best.candidate.titleNo : null;
}

/** Page through the mobile episodes API (cursor = offset) into a flat list. */
async function fetchAllEpisodes(titleNo: string): Promise<WtEpisode[]> {
  const out: WtEpisode[] = [];
  let cursor = 0;
  while (cursor < MAX_EPISODES) {
    const res = await fetchJson<{ result?: { episodeList?: WtEpisode[] } }>(
      `${MOBILE}/api/v1/webtoon/${encodeURIComponent(titleNo)}/episodes?pageSize=${PAGE_SIZE}&cursor=${cursor}`,
      { timeoutMs: 12000 },
    );
    const list = res?.result?.episodeList ?? [];
    if (list.length === 0) break;
    out.push(...list);
    if (list.length < PAGE_SIZE) break;
    cursor += PAGE_SIZE;
  }
  return out;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const titleNo = await resolveTitleNo(params);
      if (!titleNo) return [];

      const episodes = await fetchAllEpisodes(titleNo);
      if (episodes.length === 0) return [];

      const byNumber = new Map<number, MangaChapterEntry>();
      for (const ep of episodes) {
        const num = Number(ep.episodeNo);
        const link = String(ep.viewerLink || '');
        if (!link || !Number.isFinite(num) || byNumber.has(num)) continue;

        // The viewer path carries everything getPages needs; it has no colon,
        // so `webtoons:<path>` round-trips through a split on the first colon.
        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${link}`,
          providerChapterId: String(num),
          language: 'en',
          scanlator: null,
          releaseDate: ep.exposureDateMillis ? new Date(ep.exposureDateMillis).toISOString() : null,
        };
        byNumber.set(num, {
          number: num,
          title: ep.episodeTitle || null,
          volume: null,
          sources: [source],
        });
      }

      return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  },

  async getPages(chapterKey: string): Promise<MangaPageEntry[]> {
    try {
      const colonIdx = chapterKey.indexOf(':');
      const path = colonIdx >= 0 ? chapterKey.slice(colonIdx + 1) : chapterKey;
      if (!path) return [];

      const url = path.startsWith('http') ? path : `${BASE}${path}`;
      const html = await fetchText(url, { timeoutMs: 15000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const pages: MangaPageEntry[] = [];
      // The vertical-scroll viewer lazy-loads each panel from `data-url`.
      $('img._images').each((_, el) => {
        const src = ($(el).attr('data-url') || $(el).attr('data-src') || '').trim();
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
