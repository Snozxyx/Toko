/**
 * DemonicScans — https://demonicscans.org
 *
 * Plain server-rendered HTML, no Cloudflare gate on the pages we touch, no auth.
 * Three plain requests:
 *   - search  → `/search.php?manga=<q>`; cards are `a[href^="/manga/<Slug>"]`,
 *               the title sits in `.seach-right > div:first-child`.
 *   - chapters → the detail page `/manga/<Slug>`; every chapter is an
 *                `a.chplinks[href="/chaptered.php?manga=<id>&chapter=<n>"]`.
 *   - pages   → `/chaptered.php?manga=<id>&chapter=<n>` 302-redirects to the
 *               reader `/title/<Slug>/chapter/<n>/1`; panels are `img.imgholder`.
 *
 * The chapter images are served from `mangareadon.org` with literal spaces in
 * the path (e.g. `.../Solo Leveling/1/1.jpg`); we `encodeURI` them. That CDN has
 * no hotlink protection and sends no restrictive CORP header, so pages load
 * cross-origin directly — no `headers`, hence no local-proxy round-trip.
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

const BASE = 'https://demonicscans.org';
const PROVIDER_NAME = 'demonicscans';

interface DsCandidate {
  href: string; // /manga/<Slug>
  name: string;
}

/** Scrape the search page into de-duplicated {href, title} candidates. */
async function search(query: string): Promise<DsCandidate[]> {
  const html = await fetchText(`${BASE}/search.php?manga=${encodeURIComponent(query)}`, { timeoutMs: 12000 });
  if (!html) return [];
  const $ = loadHtml(html);

  const byHref = new Map<string, DsCandidate>();
  $('a[href^="/manga/"]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href') || '';
    // Title is the first div inside the `.seach-right` column of each card.
    const name = a.find('.seach-right').children('div').first().text().trim();
    if (!href || !name || byHref.has(href)) return;
    byHref.set(href, { href, name });
  });
  return Array.from(byHref.values());
}

/** Resolve an AniList id / titles to a DemonicScans detail href via fuzzy match. */
async function resolveDetailHref(params: MangaChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const pool: DsCandidate[] = [];
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
      // `.chplinks` is the real chapter list; it excludes the "Read First" nav
      // button, which reuses the same /chaptered.php shape without the class.
      $('a.chplinks[href*="/chaptered.php"]').each((_, el) => {
        const chHref = ($(el).attr('href') || '').replace(/&amp;/g, '&');
        const m = chHref.match(/chapter=([\d.]+)/i);
        const num = m ? parseFloat(m[1]) : NaN;
        if (!chHref || !Number.isFinite(num) || byNumber.has(num)) return;

        // The href carries `?`/`&` but no colon, so `demonicscans:<href>`
        // round-trips through getPages' split on the first colon.
        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${chHref}`,
          providerChapterId: String(num),
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

      // fetchText follows the 302 from /chaptered.php to the reader page.
      const url = path.startsWith('http') ? path : `${BASE}${path}`;
      const html = await fetchText(url, { timeoutMs: 15000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const pages: MangaPageEntry[] = [];
      $('img.imgholder').each((_, el) => {
        const raw = ($(el).attr('src') || $(el).attr('data-src') || '').trim();
        if (!raw.startsWith('http')) return;
        // CDN paths carry literal spaces; encode them so the <img> resolves.
        pages.push({ pageNumber: pages.length + 1, imageUrl: encodeURI(raw) });
      });
      return pages;
    } catch {
      return [];
    }
  },
};

export default provider;
