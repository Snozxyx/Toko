/**
 * NovelCool — https://www.novelcool.com  (default English / www subdomain)
 *
 * best-effort: novelcool mixes novels and manga; this targets image-chapter (manga) entries.
 *
 * Plain server-rendered HTML, no auth. NovelCool is multi-language via subdomains
 * (www=en, es/br/it/ru/de/fr); we default to the English `www` host. Both novels
 * and comics live under `/novel/{Title-With-Hyphens}.html`, so we cannot tell them
 * apart from search alone — the manga/novel split surfaces at read time: only comic
 * chapters render `img.mangaread-manga-pic`, so a text novel simply yields no pages.
 *
 * Three request shapes:
 *   - search   → `/search/?name=<query>`; result cards are `.book-item`, title in
 *                `.book-name`, series link is the `/novel/{Title}.html` anchor.
 *   - chapters → the series page `/novel/{Title}.html`; chapters are
 *                `.chapter-item-list .chp-item`, each with an `<a>` → `/chapter/{slug}/{id}/`,
 *                a label in `.chapter-item-title span`, and a date in `.chapter-item-time`.
 *   - pages    → the reader `/chapter/{slug}/{id}/`; comic panels are
 *                `img.mangaread-manga-pic` (real URL in `src`). A chapter is split
 *                across sub-pages selectable via `select.sl-page option[value]`; we
 *                walk every sub-page URL and concatenate their panels in order.
 *
 * Confirmations:
 *   - `/search/?name=` filtering and the `/novel/*.html` + `/chapter/{slug}/{id}/`
 *     URL shapes were verified live.
 *   - Chapter-list, search-card, and reader selectors come from a working NovelCool
 *     scraper (github.com/CarlosNunezMX/novel-cool: `.book-item`/`.book-name`,
 *     `.chapter-item-list .chp-item`/`.chapter-item-title span`/`.chapter-item-time`,
 *     `img.mangaread-manga-pic`, `select.sl-page option`).
 *
 * IMPORTANT (manifest): comic panels are NOT on novelcool.com — they are served by a
 * signed CDN, host `en7.movietop.cc` (subdomain varies, e.g. en1..en9.movietop.cc),
 * with `?acc=…&exp=…` tokens. Covers use `img.novelcool.com`. The movietop.cc host
 * must be allow-listed for images to load.
 *
 * best-effort: unverified — whether the movietop.cc panel CDN requires a Referer.
 * The signed URL is likely self-authorizing, so we send no `headers`; if panels 404
 * cross-origin, add `headers: { Referer: '${BASE}/' }` in getPages.
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
import type { TokoCheerio } from '../../utils/http/fetch.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://www.novelcool.com';
const PROVIDER_NAME = 'novelcool';
const MAX_SUBPAGES = 120; // safety cap on per-chapter sub-page walks

interface NcCandidate {
  href: string; // /novel/{Title}.html  (or absolute)
  name: string;
}

function toUrl(href: string): string {
  return href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
}

/** Scrape the search page into de-duplicated {href, title} candidates. */
async function search(query: string): Promise<NcCandidate[]> {
  const html = await fetchText(`${BASE}/search/?name=${encodeURIComponent(query)}`, { timeoutMs: 12000 });
  if (!html) return [];
  const $ = loadHtml(html);

  const byHref = new Map<string, NcCandidate>();

  // Primary: NovelCool's `.book-item` cards.
  $('.book-item').each((_, el) => {
    const card = $(el);
    const a = card.find('a[href*="/novel/"]').first();
    const href = (a.attr('href') || '').trim();
    const name = (card.find('.book-name').first().text() || a.attr('title') || a.text()).trim();
    if (!href || !name || byHref.has(href)) return;
    byHref.set(href, { href, name });
  });

  // Fallback: any /novel/{Title}.html anchor carrying text/title.
  if (byHref.size === 0) {
    $('a[href*="/novel/"]').each((_, el) => {
      const a = $(el);
      const href = (a.attr('href') || '').trim();
      const name = (a.attr('title') || a.text()).trim();
      if (!href || !name || !/\/novel\/.+\.html/.test(href) || byHref.has(href)) return;
      byHref.set(href, { href, name });
    });
  }

  return Array.from(byHref.values());
}

/** Resolve an AniList id / titles to a NovelCool series href via fuzzy match. */
async function resolveSeriesHref(params: MangaChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const pool: NcCandidate[] = [];
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

/** Chapter number from a label ("Vol.TBD Ch.240", "Chapter 1") or the href slug. */
function parseChapterNumber(label: string, href: string): number {
  let m = label.match(/ch(?:apter)?\.?\s*(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  m = href.split(/[?#]/)[0].match(/ch(?:apter)?[-_.\s]*(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  m = label.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

/** Numeric volume from a label; "TBD"/absent → null. */
function parseVolume(label: string): string | null {
  const m = label.match(/vol\.?\s*([\w.]+)/i);
  if (!m) return null;
  return /^\d+(?:\.\d+)?$/.test(m[1]) ? m[1] : null;
}

/** Collect comic panel URLs from one loaded reader (sub-)page, de-duped by path. */
function collectPanels($: TokoCheerio, out: string[], seenPaths: Set<string>): void {
  $('img.mangaread-manga-pic').each((_, el) => {
    const raw = ($(el).attr('src') || $(el).attr('data-src') || '').trim();
    if (!raw.startsWith('http')) return;
    const pathKey = raw.split('?')[0]; // ignore per-request signature tokens
    if (seenPaths.has(pathKey)) return;
    seenPaths.add(pathKey);
    out.push(raw);
  });
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: ['https://novelcool.com', 'https://www.novelcool.com', 'https://img.novelcool.com'],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const href = await resolveSeriesHref(params);
      if (!href) return [];

      const html = await fetchText(toUrl(href), { timeoutMs: 12000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const byNumber = new Map<number, MangaChapterEntry>();
      $('.chapter-item-list .chp-item').each((_, el) => {
        const item = $(el);
        const a = item.find('a[href*="/chapter/"]').first();
        const chHref = (a.attr('href') || '').trim();
        if (!chHref) return;

        const label = (item.find('.chapter-item-title span').first().text() || a.attr('title') || a.text()).trim();
        const num = parseChapterNumber(label, chHref);
        if (!Number.isFinite(num) || byNumber.has(num)) return;

        const date = item.find('.chapter-item-time').first().text().trim();

        // chHref is a plain path (no colon), so `novelcool:<href>` round-trips
        // through getPages' slice on the first colon.
        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${chHref}`,
          providerChapterId: chHref,
          language: 'en',
          scanlator: null,
          releaseDate: date || null,
        };
        byNumber.set(num, {
          number: num,
          title: null,
          volume: parseVolume(label),
          sources: [source],
        });
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

      const firstUrl = toUrl(path);
      const html = await fetchText(firstUrl, { timeoutMs: 15000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const panels: string[] = [];
      const seenPaths = new Set<string>();

      // A chapter is split across sub-pages listed in the page dropdown; walk them
      // in document order so panels concatenate in reading order. Reuse the already
      // fetched page for its own entry rather than re-requesting it.
      const subUrls: string[] = [];
      $('select.sl-page option').each((_, el) => {
        const v = ($(el).attr('value') || '').trim();
        if (!v) return;
        const u = v.startsWith('http') ? v : v.startsWith('/') ? `${BASE}${v}` : '';
        if (u && !subUrls.includes(u)) subUrls.push(u);
      });

      if (subUrls.length <= 1) {
        collectPanels($, panels, seenPaths);
      } else {
        const norm = (u: string) => u.replace(/\/+$/, '');
        for (const u of subUrls.slice(0, MAX_SUBPAGES)) {
          if (norm(u) === norm(firstUrl)) {
            collectPanels($, panels, seenPaths);
            continue;
          }
          const subHtml = await fetchText(u, { timeoutMs: 15000 });
          if (!subHtml) continue;
          collectPanels(loadHtml(subHtml), panels, seenPaths);
        }
        // Dropdown present but yielded nothing usable → fall back to page one.
        if (panels.length === 0) collectPanels($, panels, seenPaths);
      }

      // Signed CDN URLs are already valid; don't encodeURI (would risk mangling
      // the `acc`/`exp` tokens). No Referer sent — see header note at top of file.
      return panels.map((imageUrl, i) => ({ pageNumber: i + 1, imageUrl }));
    } catch {
      return [];
    }
  },
};

export default provider;
