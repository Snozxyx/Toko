/**
 * Toonily — https://toonily.com
 *
 * A Madara (WordPress "Manga Reader") theme site behind a full-site Cloudflare
 * challenge — a plain fetch to any path (API included) answers "Just a moment…"
 * with a 403, so every request goes through `fetchTextWithBypass`, which clears
 * the challenge once in a real browser and replays the session afterwards. This
 * is the same shape as toongod.ts.
 *
 * CONFIRMED (hakuneko Toonily connector + live pages):
 *   - Platform is WordPressMadara (hakuneko's Toonily extends `WordPressMadara`).
 *   - Detail slug is `/serie/` (e.g. https://toonily.com/serie/the-villain/).
 *     We never hardcode it though — the search hands back the full detail URL,
 *     so the three-call contract is slug-agnostic like toongod.
 *
 * ASSUMED FROM THE STANDARD MADARA CONTRACT (not re-verified live; this IP is
 * bot-blocked and the clean-IP renderer also 403s Toonily):
 *   - search   → POST `admin-ajax.php action=wp-manga-search-manga` (JSON of
 *                {title, url}); HTML `/?s=<q>&post_type=wp-manga` is the fallback.
 *   - chapters → POST `<detailUrl>ajax/chapters/`; list is `li.wp-manga-chapter a`.
 *   - pages    → GET the chapter URL; panels are `.reading-content img`, lazy
 *                (`data-src` / `data-lazy-src`, placeholder in `src`).
 *
 * KNOWN LIMITATION: Toonily gates mature (18+) titles behind a `toonily-mature=1`
 * cookie. We cannot send it here — `fetchTextWithBypass` only replays the cached
 * Cloudflare `cf_clearance` cookie when the caller sets NO `Cookie` header, so
 * adding our own would clobber the clearance and re-trigger the challenge. Non-
 * gated titles resolve fine; some adult-only series may return empty.
 *
 * No AniList id anywhere, so mapping is fuzzy title match via the shared
 * resolver. Madara CDNs hotlink-protect, so each page carries a `Referer` and
 * the local proxy replays it (and the Cloudflare session) server-side.
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

const BASE = 'https://toonily.com';
const PROVIDER_NAME = 'toonily';
const IMAGE_HEADERS = { Referer: `${BASE}/` };
const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };

interface ToonilyCandidate {
  /** Full detail URL (Toonily uses `/serie/`, but we take whatever search gives). */
  url: string;
  name: string;
}

/** Parse a chapter ordinal from its URL first, then its link text. */
function chapterNumber(href: string, text: string): number {
  const fromHref = href.match(/chapter[-_ ]?([\d.]+)/i);
  if (fromHref) {
    const n = parseFloat(fromHref[1]);
    if (Number.isFinite(n)) return n;
  }
  const fromText = text.match(/chapter\s*([\d.]+)/i);
  if (fromText) {
    const n = parseFloat(fromText[1]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

/** Madara's autosuggest API — the cleanest source of {title, url} matches. */
async function searchApi(query: string): Promise<ToonilyCandidate[]> {
  const body = `action=wp-manga-search-manga&title=${encodeURIComponent(query)}`;
  const text = await fetchTextWithBypass(`${BASE}/wp-admin/admin-ajax.php`, {
    method: 'POST',
    body,
    headers: FORM_HEADERS,
    timeoutMs: 15000,
  });
  if (!text) return [];
  try {
    const json = JSON.parse(text) as { success?: boolean; data?: Array<{ title?: string; url?: string }> };
    if (!json?.data) return [];
    const out: ToonilyCandidate[] = [];
    for (const d of json.data) {
      if (d?.url && d?.title) out.push({ url: d.url, name: d.title });
    }
    return out;
  } catch {
    return [];
  }
}

/** Fallback: scrape the rendered `/?s=` results page for {title, url} cards. */
async function searchHtml(query: string): Promise<ToonilyCandidate[]> {
  const html = await fetchTextWithBypass(
    `${BASE}/?s=${encodeURIComponent(query)}&post_type=wp-manga`,
    { timeoutMs: 15000 },
  );
  if (!html) return [];
  const $ = loadHtml(html);

  const byUrl = new Map<string, ToonilyCandidate>();
  // `.post-title a` is the Madara result card title; `.tab-thumb a` wraps the
  // cover (title lives on its sibling), so prefer real link text over the attr.
  $('.post-title a, .tab-thumb a').each((_, el) => {
    const url = ($(el).attr('href') || '').trim();
    const name = ($(el).text().trim() || $(el).attr('title') || '').trim();
    if (!url || !name || byUrl.has(url)) return;
    byUrl.set(url, { url, name });
  });
  return Array.from(byUrl.values());
}

/** Resolve an AniList id / titles to a Toonily detail URL via fuzzy match. */
async function resolveDetailUrl(params: MangaChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const pool: ToonilyCandidate[] = [];
  const seen = new Set<string>();
  for (const title of titles.slice(0, 2)) {
    let hits = await searchApi(title);
    if (hits.length === 0) hits = await searchHtml(title);
    for (const c of hits) {
      if (!seen.has(c.url)) {
        seen.add(c.url);
        pool.push(c);
      }
    }
  }

  const best = pickBestMangaCandidate(titles, pool, (c) => [c.name], 0.6);
  return best ? best.candidate.url : null;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const detailUrl = await resolveDetailUrl(params);
      if (!detailUrl) return [];

      // Madara's chapter list is a POST to `<detail>/ajax/chapters/`. Some builds
      // still inline the list on the detail page, so fall back to that HTML.
      const chaptersUrl = detailUrl.replace(/\/?$/, '/') + 'ajax/chapters/';
      let html = await fetchTextWithBypass(chaptersUrl, {
        method: 'POST',
        headers: FORM_HEADERS,
        timeoutMs: 15000,
      });
      if (!html || !/wp-manga-chapter/.test(html)) {
        html = await fetchTextWithBypass(detailUrl, { timeoutMs: 15000 });
      }
      if (!html) return [];
      const $ = loadHtml(html);

      const byNumber = new Map<number, MangaChapterEntry>();
      $('li.wp-manga-chapter a[href], .wp-manga-chapter a[href]').each((_, el) => {
        const href = ($(el).attr('href') || '').trim();
        const text = $(el).text().trim();
        if (!href || !href.includes('http')) return;
        const num = chapterNumber(href, text);
        if (!Number.isFinite(num) || byNumber.has(num)) return;

        // Store the full chapter URL after the provider prefix; getPages slices on
        // the first colon and loads it directly (the URL's own `:` survives).
        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${href}`,
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
      const url = colonIdx >= 0 ? chapterKey.slice(colonIdx + 1) : chapterKey;
      if (!url.startsWith('http')) return [];

      const html = await fetchTextWithBypass(url, { timeoutMs: 20000 });
      if (!html) return [];
      const $ = loadHtml(html);

      const pages: MangaPageEntry[] = [];
      // best-effort: unverified — reader container assumed `.reading-content img`
      // (standard Madara). Toonily lazy-loads, so prefer data-src/data-lazy-src.
      $('.reading-content img').each((_, el) => {
        const raw = (
          $(el).attr('data-src') ||
          $(el).attr('data-lazy-src') ||
          $(el).attr('src') ||
          ''
        ).trim();
        if (raw.startsWith('http')) {
          pages.push({ pageNumber: pages.length + 1, imageUrl: raw, headers: IMAGE_HEADERS });
        }
      });
      return pages;
    } catch {
      return [];
    }
  },
};

export default provider;
