/**
 * OniSaga — https://onisaga.com
 *
 * A free manga/manhwa reader that answers a plain fetch with 403 (bot-walled),
 * so every request goes through `fetchTextWithBypass` to clear the Cloudflare
 * challenge and replay the session, exactly like toongod.ts / toonily.ts.
 *
 * best-effort: platform assumed Madara, 403 blocked fingerprinting. This IP is
 * bot-blocked AND the clean-IP WebFetch renderer also returns 403 for onisaga.com,
 * so none of the three Madara calls could be verified against the live site. The
 * code below applies the STANDARD Madara (WordPress "Manga Reader") contract,
 * which is the overwhelmingly common shape for sites of this kind:
 *   - search   → POST `admin-ajax.php action=wp-manga-search-manga` (JSON of
 *                {title, url}); HTML `/?s=<q>&post_type=wp-manga` is the fallback.
 *   - chapters → POST `<detailUrl>ajax/chapters/`; list is `li.wp-manga-chapter a`.
 *   - pages    → GET the chapter URL; panels are `.reading-content img`, lazy
 *                (`data-src` / `data-lazy-src`, placeholder in `src`).
 *
 * UNCONFIRMED, needs deployment verification:
 *   - best-effort: unverified — detail-URL slug (Madara renames `/manga/` →
 *     `/webtoon/`, `/series/`, …). Harmless here: the search returns the full
 *     detail URL, so the contract is slug-agnostic. Only matters if OniSaga is
 *     NOT Madara (e.g. a custom/Next.js SPA with a JSON API), in which case this
 *     provider will return [] and need a rewrite against the real endpoints.
 *   - best-effort: unverified — reader image selector and lazy attributes.
 *
 * No AniList id, so mapping is fuzzy title match via the shared resolver. Madara
 * CDNs typically hotlink-protect, so each page carries a `Referer` the local
 * proxy replays (and the Cloudflare session) server-side.
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

const BASE = 'https://onisaga.com';
const PROVIDER_NAME = 'onisaga';
const IMAGE_HEADERS = { Referer: `${BASE}/` };
const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };

interface OniCandidate {
  /** Full detail URL (whatever post-type base the site uses). */
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
async function searchApi(query: string): Promise<OniCandidate[]> {
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
    const out: OniCandidate[] = [];
    for (const d of json.data) {
      if (d?.url && d?.title) out.push({ url: d.url, name: d.title });
    }
    return out;
  } catch {
    return [];
  }
}

/** Fallback: scrape the rendered `/?s=` results page for {title, url} cards. */
async function searchHtml(query: string): Promise<OniCandidate[]> {
  const html = await fetchTextWithBypass(
    `${BASE}/?s=${encodeURIComponent(query)}&post_type=wp-manga`,
    { timeoutMs: 15000 },
  );
  if (!html) return [];
  const $ = loadHtml(html);

  const byUrl = new Map<string, OniCandidate>();
  // best-effort: unverified — Madara result-card selectors assumed standard.
  $('.post-title a, .tab-thumb a').each((_, el) => {
    const url = ($(el).attr('href') || '').trim();
    const name = ($(el).text().trim() || $(el).attr('title') || '').trim();
    if (!url || !name || byUrl.has(url)) return;
    byUrl.set(url, { url, name });
  });
  return Array.from(byUrl.values());
}

/** Resolve an AniList id / titles to an OniSaga detail URL via fuzzy match. */
async function resolveDetailUrl(params: MangaChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const pool: OniCandidate[] = [];
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

      // best-effort: unverified — Madara's chapter list POST to `<detail>/ajax/chapters/`.
      // Some builds still inline the list on the detail page, so fall back to that HTML.
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
      // (standard Madara), lazy-loaded via data-src/data-lazy-src.
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
