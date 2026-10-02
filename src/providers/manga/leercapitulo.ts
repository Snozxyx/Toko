/**
 * LeerCapitulo — https://www.leercapitulo.co  (SPANISH)
 *
 * Plain server-rendered HTML, no Cloudflare gate on the pages we touch, no auth.
 * Three plain requests:
 *   - search   → `/manga/?q=<query>`; result cards are `article.lc-card`, each
 *                carrying its link+title in `a.lc-card-name` (href → /manga/{id}/{slug}/).
 *   - chapters → the detail page `/manga/{id}/{slug}/`; every chapter is an
 *                `a.lc-chapter-row[href="/leer/{id}/{slug}/{chapter}/"]`, with the
 *                label in `.n` and the release date (yyyy-MM-dd) in `.d`.
 *   - pages    → the reader `/leer/{id}/{slug}/{chapter}/`; panels are
 *                `#lcPages img[data-src]` (the real URL lives in `data-src`).
 *
 * Selectors confirmed against the maintained keiyoushi Tachiyomi/Mihon extension
 * (`src/es/leercapitulo`): search param `q`, card `article.lc-card` / `a.lc-card-name`,
 * chapter `a.lc-chapter-row` with `.n`/`.d`, pages `#lcPages img[data-src]`.
 * The `/manga/?q=` search and `/manga/`+`/leer/` URL shapes were additionally
 * verified live. The extension adds no image Referer (no imageRequest override),
 * so panels load cross-origin directly — no `headers`, no local-proxy round-trip.
 *
 * best-effort: unverified — the image CDN host could not be captured (data-src is
 * populated lazily and absent from the static markup). We absolutize + encodeURI
 * the data-src and send no Referer, matching the extension; if the CDN turns out
 * to hotlink-protect, add `headers: { Referer: '${BASE}/' }` in getPages.
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

const BASE = 'https://www.leercapitulo.co';
const PROVIDER_NAME = 'leercapitulo';

interface LcCandidate {
  href: string; // /manga/{id}/{slug}/  (or absolute)
  name: string;
}

/** Absolute → path-or-absolute helper so BASE prefixing stays idempotent. */
function toUrl(href: string): string {
  return href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
}

/** Scrape the search page into de-duplicated {href, title} candidates. */
async function search(query: string): Promise<LcCandidate[]> {
  const html = await fetchText(`${BASE}/manga/?q=${encodeURIComponent(query)}`, { timeoutMs: 12000 });
  if (!html) return [];
  const $ = loadHtml(html);

  const byHref = new Map<string, LcCandidate>();

  // Primary: the maintained extension's card shape.
  $('article.lc-card').each((_, el) => {
    const a = $(el).find('a.lc-card-name').first();
    const href = (a.attr('href') || '').trim();
    const name = a.text().trim();
    if (!href || !name || byHref.has(href)) return;
    byHref.set(href, { href, name });
  });

  // Fallback: resilient to card-markup changes — any /manga/{id}/{slug}/ anchor
  // that carries visible text.
  if (byHref.size === 0) {
    $('a[href*="/manga/"]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      const name = $(el).text().trim();
      // Catalogue/filter links (/manga/?genre=...) have no {id}/{slug} segment.
      if (!href || !name || !/\/manga\/[^/?]+\/[^/?]+/.test(href) || byHref.has(href)) return;
      byHref.set(href, { href, name });
    });
  }

  return Array.from(byHref.values());
}

/** Resolve an AniList id / titles to a LeerCapitulo detail href via fuzzy match. */
async function resolveDetailHref(params: MangaChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const pool: LcCandidate[] = [];
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

/** Pull the chapter number out of a `/leer/{id}/{slug}/{chapter}/` href. */
function chapterNumberFromHref(href: string): number {
  const segs = href.split(/[?#]/)[0].split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  const n = parseFloat(last || '');
  return Number.isFinite(n) ? n : NaN;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: [BASE, 'https://leercapitulo.co'],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const href = await resolveDetailHref(params);
      if (!href) return [];

      const html = await fetchText(toUrl(href), { timeoutMs: 12000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const byNumber = new Map<number, MangaChapterEntry>();
      $('a.lc-chapter-row').each((_, el) => {
        const a = $(el);
        const chHref = (a.attr('href') || '').trim();
        if (!chHref) return;

        let num = chapterNumberFromHref(chHref);
        if (!Number.isFinite(num)) {
          // Fallback: parse the label, e.g. "Capitulo 1104.5".
          const m = a.find('.n').text().match(/([\d.]+)/);
          num = m ? parseFloat(m[1]) : NaN;
        }
        if (!Number.isFinite(num) || byNumber.has(num)) return;

        const date = a.find('.d').first().text().trim(); // yyyy-MM-dd

        // The href is a plain path (no colon), so `leercapitulo:<href>`
        // round-trips through getPages' slice on the first colon.
        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${chHref}`,
          providerChapterId: chHref,
          language: 'es',
          scanlator: null,
          releaseDate: date || null,
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

      const html = await fetchText(toUrl(path), { timeoutMs: 15000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const pages: MangaPageEntry[] = [];
      $('#lcPages img[data-src]').each((_, el) => {
        const raw = ($(el).attr('data-src') || '').trim();
        if (!raw) return;
        const abs = raw.startsWith('http') ? raw : toUrl(raw);
        // The CDN host is unconfirmed; encodeURI guards against literal spaces,
        // and the extension sends no Referer, so no `headers` here.
        pages.push({ pageNumber: pages.length + 1, imageUrl: encodeURI(abs) });
      });
      return pages;
    } catch {
      return [];
    }
  },
};

export default provider;
