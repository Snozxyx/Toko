/**
 * NovelBuddy — https://novelbuddy.me (migrated from novelbuddy.com)
 *
 * Next.js site: search/series/chapter pages are client-rendered, but the
 * framework's own `/_next/data/<buildId>/…json` endpoints serve the same
 * payloads as JSON — the contract the web client itself uses:
 *   - search   → `/_next/data/<buildId>/search.json?keyword=<q>`
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
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://novelbuddy.me';
const PROVIDER_NAME = 'novelbuddy';
/** Origins accepted for saved chapter keys (old domain redirected here). */
const KNOWN_ORIGINS = new Set([BASE, 'https://www.novelbuddy.me', 'https://novelbuddy.com', 'https://www.novelbuddy.com']);

let cachedBuildId: string | null = null;

async function getBuildId(): Promise<string> {
  if (cachedBuildId) return cachedBuildId;
  const res = await fetchResponse(`${BASE}/search`, { timeoutMs: 12000 });
  if (!res.ok) {
    throw new Error(`novelbuddy search returned HTTP ${res.status}${res.status === 403 ? ' (access blocked)' : ''}`);
  }
  const html = await res.text().catch(() => '');
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
  const buildId = await getBuildId();
  const url = `${BASE}/_next/data/${buildId}/search.json?keyword=${encodeURIComponent(query)}`;
  const res = await fetchResponse(url, {
    timeoutMs: 15000,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`novelbuddy search returned HTTP ${res.status}${res.status === 403 ? ' (access blocked)' : ''}`);
  }
  const json = await res.json().catch(() => null);
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
  const best = pickBestMangaCandidate(titles, pool, (c) => [c.name], 0.6);
  if (best) return best.candidate.href.replace(/^\/+|\/+$/g, '');
  if (pool.length === 0 && lastError) throw lastError;
  return null;
}

function seriesSlugFrom(params: NovelChapterParams, resolved: string | null): string | null {
  if (params.seriesId) {
    try {
      const u = new URL(params.seriesId.startsWith('http') ? params.seriesId : `${BASE}${params.seriesId.startsWith('/') ? '' : '/'}${params.seriesId}`);
      if (!KNOWN_ORIGINS.has(u.origin)) throw new Error('Invalid novelbuddy title URL');
      const slug = u.pathname.split('/').filter(Boolean)[0] || '';
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
      const slug = seriesSlugFrom(params, await resolveSeriesSlug(params).catch(() => null));
      if (!slug) return [];
      const buildId = await getBuildId();
      const data = await fetchJson<{ pageProps?: { initialManga?: { chapters?: unknown } } }>(
        `${BASE}/_next/data/${buildId}/${encodeURIComponent(slug)}.json`,
        { timeoutMs: 15000 },
      );
      const rows = data?.pageProps?.initialManga?.chapters;
      if (!Array.isArray(rows)) return [];
      const entries: NovelChapterEntry[] = [];
      const seen = new Set<number>();
      for (const row of rows) {
        const r = row as { number?: unknown; name?: unknown; url?: unknown; updatedAt?: unknown; date?: unknown };
        const number = Number(r.number);
        if (!Number.isFinite(number) || number <= 0 || seen.has(number)) continue;
        const chapterUrl = `${BASE}${String(r.url || '')}`;
        if (!chapterUrl.startsWith(`${BASE}/`)) continue;
        seen.add(number);
        const source: NovelChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${encodeURIComponent(chapterUrl)}`,
          providerChapterId: chapterUrl,
          language: 'en',
          translator: null,
          releaseDate: typeof r.updatedAt === 'string' ? r.updatedAt : typeof r.date === 'string' ? r.date : null,
        };
        entries.push({
          number,
          title: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `Chapter ${number}`,
          volume: null,
          sources: [source],
        });
      }
      return entries.sort((a, b) => a.number - b.number);
    } catch {
      return [];
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
      const buildId = await getBuildId();
      const data = await fetchJson<{ pageProps?: { initialChapter?: unknown } }>(
        `${BASE}/_next/data/${buildId}/${segs[0]}/${segs[1]}.json`,
        { timeoutMs: 15000 },
      );
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
      const number = Number(ch.number);
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
