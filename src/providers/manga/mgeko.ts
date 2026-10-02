/**
 * Mgeko — https://www.mgeko.cc
 *
 * Custom server-rendered HTML site (NOT Madara). Fingerprinted via clean-IP
 * requests on 2026-10-01:
 *   - Search:       GET /search/?search={q}
 *                   -> HTML; results are `a[href^="/manga/"]` cards whose link
 *                      text is the title.                              [confirmed]
 *   - Series slug:  /manga/{hash-slug}/   e.g. /manga/c9me-solo-swordmaster/
 *                                                                      [confirmed]
 *   - All chapters: /manga/{slug}/all-chapters/
 *                   -> every chapter as
 *                      `a[href="/reader/en/{slug}-chapter-{N}-eng-li/"]`.[confirmed]
 *   - Reader:       /reader/en/{slug}-chapter-{N}-eng-li/
 *                   -> page images at
 *                      https://imgsrv5.com/sv2/comic/{slug}/chapter-{N}/{i}.jpg
 *                                                            [confirmed URL pattern]
 *
 * There is no AniList/MAL id anywhere on the site, so mapping is a fuzzy title
 * match via the shared resolver. English-only catalogue.
 *
 * // best-effort: /portal/api not confirmed, using HTML path
 *   `/portal/api/{login,signup}` exist but no JSON search / chapter-list /
 *   page-image endpoint was discoverable, so every step scrapes HTML.
 *
 * Requests go through `fetchTextWithBypass` so the provider keeps working if the
 * origin is ever put behind a Cloudflare challenge; for a clean 200 it behaves
 * exactly like a plain fetch.
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

const BASE = 'https://www.mgeko.cc';
const PROVIDER_NAME = 'mgeko';
// best-effort: unverified — imgsrv5.com almost certainly hot-link protects like
// its sibling CDNs, so pages carry the site Referer for the local proxy.
const IMAGE_HEADERS = { Referer: `${BASE}/` };

interface MgCandidate {
  href: string; // /manga/{hash-slug}/
  name: string;
}

/** Scrape /search into de-duplicated {href, title} series candidates. */
async function search(query: string): Promise<MgCandidate[]> {
  const html = await fetchTextWithBypass(`${BASE}/search/?search=${encodeURIComponent(query)}`, {
    timeoutMs: 12000,
  });
  if (!html) return [];
  const $ = loadHtml(html);

  const byHref = new Map<string, MgCandidate>();
  $('a[href^="/manga/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const name = $(el).text().trim();
    // The card image is also a /manga/ anchor but carries no text; keep only the
    // named title anchor, and ignore the all-chapters sub-link.
    if (!href || !name || href.includes('/all-chapters')) return;
    if (!byHref.has(href)) byHref.set(href, { href, name });
  });
  return Array.from(byHref.values());
}

/** Resolve an AniList id / titles to a Mgeko /manga/{slug}/ href via fuzzy match. */
async function resolveSeriesHref(params: MangaChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const pool: MgCandidate[] = [];
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

/** Pull the chapter number out of a /reader/en/{slug}-chapter-{N}-eng-li/ href. */
function chapterNumberFromHref(href: string): number {
  const m = href.match(/-chapter-([\d.]+)/i);
  if (m) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: ['https://www.mgeko.cc', 'https://mgeko.cc'],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const href = await resolveSeriesHref(params);
      if (!href) return [];

      // The series page shows only a slice; /all-chapters/ lists every chapter.
      const seriesPath = href.endsWith('/') ? href : `${href}/`;
      const html = await fetchTextWithBypass(`${BASE}${seriesPath}all-chapters/`, { timeoutMs: 15000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const byNumber = new Map<number, MangaChapterEntry>();
      $('a[href*="/reader/"]').each((_, el) => {
        const chHref = $(el).attr('href') || '';
        const num = chapterNumberFromHref(chHref);
        if (!chHref || !Number.isFinite(num) || byNumber.has(num)) return;

        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${chHref}`,
          providerChapterId: chHref,
          language: 'en',
          scanlator: null,
          // The list only renders relative ages ("21 hours"), no absolute date.
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

      const url = path.startsWith('http')
        ? path
        : `${BASE}${path.startsWith('/') ? '' : '/'}${path}`;
      const html = await fetchTextWithBypass(url, { timeoutMs: 15000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const pages: MangaPageEntry[] = [];
      const seen = new Set<string>();
      // best-effort: unverified — reader lazy-loads images, exact attribute/class
      // unconfirmed, so match by the confirmed CDN host / /comic/.../chapter-
      // path across data-src|src|data-original and drop the credits banner.
      $('img').each((_, el) => {
        const src = (
          $(el).attr('data-src') ||
          $(el).attr('src') ||
          $(el).attr('data-original') ||
          ''
        ).trim();
        if (!src.startsWith('http')) return;
        const isPage = /imgsrv/i.test(src) || (/\/comic\//i.test(src) && /chapter-/i.test(src));
        if (!isPage || /credits|logo|banner/i.test(src) || seen.has(src)) return;
        seen.add(src);
        pages.push({ pageNumber: pages.length + 1, imageUrl: src, headers: IMAGE_HEADERS });
      });
      return pages;
    } catch {
      return [];
    }
  },
};

export default provider;
