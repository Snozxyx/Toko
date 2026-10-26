/**
 * NovelBuddy — https://novelbuddy.me (migrated from novelbuddy.com)
 *
 * Next.js site: search/series/chapter pages are client-rendered, but the
 * framework's own `/_next/data/<buildId>/…json` endpoints serve the same
 * payloads as JSON — the contract the web client itself uses:
 *   - search   → `/_next/data/<buildId>/search.json?q=<q>`
 *                `pageProps.ssrItems[]` → `{ slug, name }`; series URL is
 *                `/<slug>` (single segment, no `/novel/` prefix).
 *   - chapters → `/_next/data/<buildId>/<series-slug>.json`
 *                `pageProps.initialManga.chapters[]` → `{ number, name,
 *                slug, url, updatedAt }` (latest ~50, newest-first; `number`
 *                is authoritative). Sorted ascending here; the reader merges
 *                across providers by number, so partial coverage still helps.
 *   - content  → `/_next/data/<buildId>/<series>/<chapter>.json`
 *                `pageProps.initialChapter` → `{ name, number, content }`
 *                where `content` is an HTML fragment (`<p>` paragraphs).
 *
 * The build id rotates per deploy and is resolved at runtime from the search
 * page's `/_next/static/<buildId>/_buildManifest.js` asset URL (cached).
 * Chapter keys stay `novelbuddy:<encoded chapter URL>`; legacy
 * novelbuddy.com keys are accepted and resolved against the new host.
 *
 * No AniList id on-page — fuzzy title match via the shared resolver.
 * best-effort: every step degrades to []/null so the reader falls back to
 * the next provider.
 */
import type {
  NovelProvider,
  NovelChapterEntry,
  NovelChapterParams,
  NovelChapterSource,
  NovelContentEntry,
} from '../../types/index.js';

import { fetchJson, fetchResponse, loadHtml } from '../../utils/http/fetch.js';
import { resolveMangaTitles } from '../../utils/manga/manga-title-resolver.js';
import { pickBestNovelProviderCandidate } from '../../utils/novel-title-match.js';
import { fetchNovelSearchHtml } from './novel-http.js';

const BASE = 'https://novelbuddy.me';
const PROVIDER_NAME = 'novelbuddy';
/** Origins accepted for saved chapter keys (old domain redirected here). */
const KNOWN_ORIGINS = new Set([BASE, 'https://www.novelbuddy.me', 'https://novelbuddy.com', 'https://www.novelbuddy.com']);

let cachedBuildId: string | null = null;
async function pageData(path: string): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const buildId = await getBuildId();
    const response = await fetchResponse(`${BASE}/_next/data/${buildId}/${path}`, { timeoutMs: 12000, headers: { Accept: 'application/json' } });
    if (response.status === 404 && attempt === 0) { cachedBuildId = null; continue; }
    if (!response.ok) throw new Error(`novelbuddy returned HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.pageProps) throw new Error('novelbuddy returned an invalid page payload');
    return data;
  }
}

async function getBuildId(): Promise<string> {
  if (cachedBuildId) return cachedBuildId;
  const html = await fetchNovelSearchHtml(`${BASE}/search`);
  const match = html.match(/\/_next\/static\/([A-Za-z0-9_-]+)\/_buildManifest\.js/);
  if (!match) throw new Error('novelbuddy search is unavailable (site layout changed)');
  cachedBuildId = match[1];
  return match[1];
}

interface BuddyCandidate {
  href: string;
  name: string;
}

async function searchSeries(query: string): Promise<BuddyCandidate[]> {
  const json = await pageData(`search.json?q=${encodeURIComponent(query)}`);
  const items = json?.pageProps?.ssrItems;
  if (!Array.isArray(items)) return [];
  const out: BuddyCandidate[] = [];
  const seen = new Set<string>();
  for (const row of items) {
    const slug = String(row?.slug || '').trim();
    const name = String(row?.name || '').trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z0-9-]+$/.test(slug) || !name || name.length < 2 || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ href: `/${slug}`, name });
  }
  return out.slice(0, 20);
}

async function resolveSeriesSlug(params: NovelChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;
  const pool: BuddyCandidate[] = [];
  const seen = new Set<string>();
  let lastError: unknown = null;
  for (const title of titles.slice(0, 2)) {
    let cands: BuddyCandidate[] = [];
    try {
      cands = await searchSeries(title);
    } catch (err) {
      lastError = err;
      continue;
    }
    for (const cand of cands) {
      if (seen.has(cand.href)) continue;
      seen.add(cand.href);
      pool.push(cand);
    }
  }
  const best = pickBestNovelProviderCandidate(titles, pool, (c) => [c.name], 0.6);
  if (best) return best.candidate.href.replace(/^\/+|\/+$/g, '');
  if (pool.length === 0 && lastError) throw lastError;
  return null;
}

function seriesSlugFrom(params: NovelChapterParams, resolved: string | null): string | null {
  if (params.seriesId) {
    try {
      const u = new URL(params.seriesId.startsWith('http') ? params.seriesId : `${BASE}${params.seriesId.startsWith('/') ? '' : '/'}${params.seriesId}`);
      if (!KNOWN_ORIGINS.has(u.origin)) throw new Error('Invalid novelbuddy title URL');
      const segments = u.pathname.split('/').filter(Boolean);
      const slug = segments[0] === 'novel' ? segments[1] || '' : segments[0] || '';
      if (/^[A-Za-z0-9-]+$/.test(slug)) return slug;
      return null;
    } catch {
      return null;
    }
  }
  return resolved;
}

const provider: NovelProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],
  async search(query) {
    return (await searchSeries(query)).map((row) => ({ id: row.href, title: row.name, url: `${BASE}${row.href}` }));
  },

  async getChapters(params: NovelChapterParams): Promise<NovelChapterEntry[]> {
    try {
      const slug = seriesSlugFrom(params, params.seriesId ? null : await resolveSeriesSlug(params));
      if (!slug) return [];
      const data = await pageData(`${encodeURIComponent(slug)}.json`);
      const manga = data?.pageProps?.initialManga;
      let rows = manga?.chapters;
      if (/^[A-Za-z0-9]+$/.test(manga?.id || '')) {
        const archive = await fetchJson<any>(`https://api.novelbuddy.me/titles/${manga.id}/chapters`, { timeoutMs: 12000 });
        if (Array.isArray(archive?.data?.chapters)) rows = archive.data.chapters;
      }
      if (!Array.isArray(rows)) return [];
      const entries: NovelChapterEntry[] = [];
      const seen = new Set<number>();
      for (const row of rows) {
        const r = row as { number?: unknown; name?: unknown; url?: unknown; updatedAt?: unknown; updated_at?: unknown; date?: unknown };
        // The API's "number" is a sort ordinal (Overgeared is off by one).
        // Use the published chapter label when available for cross-site merging.
        const labelNumber = /\b(?:vol(?:ume)?\.?|part)\s*\d/i.test(String(r.name || '')) ? undefined : String(r.name || '').match(/chapter\s*(\d+(?:\.\d+)?)/i)?.[1];
        const number = Number(labelNumber ?? r.number);
        if (!Number.isFinite(number) || number <= 0 || seen.has(number)) continue;
        const chapterUrl = new URL(String(r.url || ''), BASE).href;
        if (!r.url || new URL(chapterUrl).origin !== BASE) continue;
        seen.add(number);
        const source: NovelChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${encodeURIComponent(chapterUrl)}`,
          providerChapterId: chapterUrl,
          language: 'en',
          translator: null,
          releaseDate: typeof r.updatedAt === 'string' ? r.updatedAt : typeof r.updated_at === 'string' ? r.updated_at : typeof r.date === 'string' ? r.date : null,
        };
        entries.push({
          number,
          title: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `Chapter ${number}`,
          volume: null,
          sources: [source],
        });
      }
      return entries.sort((a, b) => a.number - b.number);
    } catch (error) {
      throw error;
    }
  },

  async getContent(chapterKey: string): Promise<NovelContentEntry | null> {
    try {
      const prefix = `${PROVIDER_NAME}:`;
      if (!chapterKey.startsWith(prefix)) return null;
      const u = new URL(decodeURIComponent(chapterKey.slice(prefix.length)));
      if (!KNOWN_ORIGINS.has(u.origin)) return null;
      const segs = u.pathname.split('/').filter(Boolean);
      if (segs.length < 2 || !/^[A-Za-z0-9-]+$/.test(segs[0]) || !/^[A-Za-z0-9-]+$/.test(segs[1])) return null;
      const data = await pageData(`${segs[0]}/${segs[1]}.json`);
      const ch = data?.pageProps?.initialChapter as
        | { name?: unknown; number?: unknown; content?: unknown }
        | undefined;
      if (!ch || typeof ch.content !== 'string' || !ch.content) return null;
      const $ = loadHtml(`<div>${ch.content}</div>`);
      const texts: string[] = [];
      $('p').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text) texts.push(text);
      });
      if (texts.length === 0) return null;
      const number = Number((/\b(?:vol(?:ume)?\.?|part)\s*\d/i.test(String(ch.name || '')) ? undefined : String(ch.name || '').match(/chapter\s*(\d+(?:\.\d+)?)/i)?.[1]) ?? ch.number);
      return {
        title: typeof ch.name === 'string' && ch.name.trim() ? ch.name.trim() : null,
        number: Number.isFinite(number) ? number : null,
        paragraphs: texts.map((text, index) => ({ index, text })),
        provider: PROVIDER_NAME,
      };
    } catch {
      return null;
    }
  },
};

export default provider;
