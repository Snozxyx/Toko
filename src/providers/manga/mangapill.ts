/**
 * Mangapill — https://mangapill.com
 *
 * Plain server-rendered HTML, no Cloudflare, no auth. Search returns manga
 * cards, the detail page lists every chapter, and each chapter page ships its
 * images as `img.js-page[data-src]` on the `readdetectiveconan` CDN. Those CDN
 * hosts hotlink-protect, so pages carry a `Referer` for the local proxy to
 * replay when it converts them to `proxiedImageUrl`.
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

const BASE = 'https://mangapill.com';
const PROVIDER_NAME = 'mangapill';
const IMAGE_HEADERS = { Referer: `${BASE}/` };

interface MpCandidate {
  href: string; // /manga/{id}/{slug}
  name: string;
}

/** Scrape the search page into de-duplicated {href, title} candidates. */
async function search(query: string): Promise<MpCandidate[]> {
  const html = await fetchText(`${BASE}/search?q=${encodeURIComponent(query)}`, { timeoutMs: 12000 });
  if (!html) return [];
  const $ = loadHtml(html);

  const byHref = new Map<string, MpCandidate>();
  $('a[href^="/manga/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const name = $(el).text().trim();
    // The card image is also a /manga/ anchor but has no text; the title
    // anchor is the one carrying the name. Keep only the named one per manga.
    if (!href || !name) return;
    if (!byHref.has(href)) byHref.set(href, { href, name });
  });
  return Array.from(byHref.values());
}

/** Resolve an AniList id / titles to a Mangapill detail href via fuzzy match. */
async function resolveDetailHref(params: MangaChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const pool: MpCandidate[] = [];
  const seen = new Set<string>();
  for (const title of titles.slice(0, 2)) {
    for (const cand of await search(title)) {
      if (!seen.has(cand.href)) {
        seen.add(cand.href);
        pool.push(cand);
      }
    }
  }

  const best = pickBestMangaCandidate(titles, pool, (c) => [c.name], 0.6);
  return best ? best.candidate.href : null;
}

function chapterNumber(href: string, text: string): number {
  const fromSlug = href.match(/-chapter-([\d.]+)/i);
  if (fromSlug) {
    const n = parseFloat(fromSlug[1]);
    if (Number.isFinite(n)) return n;
  }
  const fromText = text.match(/chapter\s*([\d.]+)/i);
  if (fromText) {
    const n = parseFloat(fromText[1]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const href = await resolveDetailHref(params);
      if (!href) return [];

      const html = await fetchText(`${BASE}${href}`, { timeoutMs: 12000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const byNumber = new Map<number, MangaChapterEntry>();
      $('a[href^="/chapters/"]').each((_, el) => {
        const chHref = $(el).attr('href') || '';
        const text = $(el).text().trim();
        const num = chapterNumber(chHref, text);
        if (!chHref || !Number.isFinite(num) || byNumber.has(num)) return;

        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${chHref}`,
          providerChapterId: chHref,
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
      const path = colonIdx >= 0 ? chapterKey.slice(colonIdx + 1) : chapterKey;
      if (!path) return [];

      const html = await fetchText(`${BASE}${path}`, { timeoutMs: 15000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const pages: MangaPageEntry[] = [];
      $('img[data-src]').each((_, el) => {
        const src = $(el).attr('data-src') || '';
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
