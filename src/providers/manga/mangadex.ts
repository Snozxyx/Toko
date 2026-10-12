/**
 * MangaDex — https://mangadex.org (API: https://api.mangadex.org)
 *
 * The lead manga provider and the only deterministic one: MangaDex stores the
 * AniList id on each title (`attributes.links.al`), so an AniList id maps to an
 * exact MangaDex manga with no fuzzy guessing. When the id link is missing we
 * fall back to fuzzy title matching like every other provider.
 *
 * Public JSON API, no anti-bot, no auth. Images come from a per-request at-home
 * CDN node and need no Referer, so pages carry no `headers`.
 *
 * Requirements: manga mapping (deterministic AniList → provider).
 */
import type {
  MangaProvider,
  MangaChapterEntry,
  MangaChapterParams,
  MangaChapterSource,
  MangaPageEntry,
} from '../../types/index.js';

import { fetchJson } from '../../utils/http/fetch.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const API = 'https://api.mangadex.org';
const PROVIDER_NAME = 'mangadex';
// Include the fuller content ratings so mature titles still resolve; the app
// gates what a user sees, not the provider.
const CONTENT_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'];

interface MdManga {
  id: string;
  attributes?: {
    title?: Record<string, string>;
    altTitles?: Array<Record<string, string>>;
    links?: Record<string, string>;
    availableTranslatedLanguages?: string[];
  };
}

interface MdChapter {
  id: string;
  attributes?: {
    chapter?: string | null;
    title?: string | null;
    volume?: string | null;
    translatedLanguage?: string | null;
    publishAt?: string | null;
    pages?: number;
    externalUrl?: string | null;
  };
  relationships?: Array<{ type: string; attributes?: { name?: string } }>;
}

/** Order a chapter's sources English-first, then alphabetically by language. */
function orderSources(a: MangaChapterSource, b: MangaChapterSource): number {
  const rank = (l: string) => (l === 'en' ? 0 : 1);
  const r = rank(a.language) - rank(b.language);
  return r !== 0 ? r : a.language.localeCompare(b.language);
}

function allNames(m: MdManga): string[] {
  const names: string[] = [];
  const title = m.attributes?.title ?? {};
  for (const v of Object.values(title)) if (v) names.push(v);
  for (const alt of m.attributes?.altTitles ?? []) {
    for (const v of Object.values(alt)) if (v) names.push(v);
  }
  return names;
}

/** Resolve an AniList id / titles to a MangaDex manga id. Deterministic first. */
async function resolveMangaId(params: MangaChapterParams): Promise<MdManga | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const anilistId = Number(params.anilistId);
  const wantAl = Number.isFinite(anilistId) && anilistId > 0 ? String(anilistId) : null;

  // Search the two best titles; that is enough to surface the right manga while
  // bounding requests against the ~5 req/s limit.
  const seen = new Set<string>();
  const pool: MdManga[] = [];
  for (const title of titles.slice(0, 2)) {
    const url =
      `${API}/manga?title=${encodeURIComponent(title)}&limit=15` +
      CONTENT_RATINGS.map((r) => `&contentRating[]=${r}`).join('');
    const res = await fetchJson<{ data?: MdManga[] }>(url, { timeoutMs: 12000 });
    for (const m of res?.data ?? []) {
      if (m?.id && !seen.has(m.id)) {
        seen.add(m.id);
        pool.push(m);
        // Deterministic hit: the AniList id is stamped on the title itself.
        if (wantAl && String(m.attributes?.links?.al) === wantAl) return m;
      }
    }
  }

  const best = pickBestMangaCandidate(titles, pool, (m) => allNames(m), 0.6);
  return best ? best.candidate : null;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: ['https://mangadex.org'],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const manga = await resolveMangaId(params);
      if (!manga) return [];

      const byNumber = new Map<number, MangaChapterEntry>();
      const limit = 500;
      const seen = new Set<string>();
      const languages = [...new Set(manga.attributes?.availableTranslatedLanguages || [])];
      const feeds: Array<string | undefined> = [undefined];

      // Page through the feed in ALL translated languages — each language's
      // chapter becomes its own source and the reader picks per chapter.
      // limit=500 (MangaDex max) clears most series in a couple of requests;
      // the offset cap is raised to absorb the larger all-language feed while
      // still bounding a pathological title.
      for (const language of feeds) {
      let offset = 0;
      let total = Infinity;
      while (offset < total && offset + limit <= 10000) {
        const url =
          `${API}/manga/${manga.id}/feed?limit=${limit}&offset=${offset}` +
          `&order[chapter]=asc&order[volume]=asc` +
          `&includes[]=scanlation_group&includeExternalUrl=0&includeEmptyPages=0&includeFuturePublishAt=0` +
          (language ? `&translatedLanguage[]=${encodeURIComponent(language)}` : '') +
          CONTENT_RATINGS.map((r) => `&contentRating[]=${r}`).join('');
        const res = await fetchJson<{ data?: MdChapter[]; total?: number }>(url, { timeoutMs: 12000 });
        // Keep successfully fetched pages when a later page is unavailable.
        if (!res) break;
        const rows = res?.data ?? [];
        total = typeof res?.total === 'number' ? res.total : rows.length;
        // Large multilingual feeds exceed one offset window. Partition by
        // language instead, preserving every group and deduplicating UUIDs.
        const partition = !language && total > 10000 && languages.length > 1;
        if (partition) feeds.push(...languages);
        if (rows.length === 0) break;

        for (const ch of rows) {
          const rawNumber = String(ch.attributes?.chapter ?? '').trim();
          if (!/^\d+(?:\.\d+)?$/.test(rawNumber) || ch.attributes?.externalUrl || ch.attributes?.pages === 0 || !ch.id || seen.has(ch.id)) continue;
          const num = Number(rawNumber);
          if (!Number.isFinite(num)) continue;
          seen.add(ch.id);
          const scanlator =
            ch.relationships?.filter(r => r.type === 'scanlation_group').map(r => r.attributes?.name).filter(Boolean).join(', ') || null;
          const source: MangaChapterSource = {
            provider: PROVIDER_NAME,
            chapterKey: `${PROVIDER_NAME}:${ch.id}`,
            providerChapterId: ch.id,
            language: ch.attributes?.translatedLanguage ?? 'en',
            scanlator,
            releaseDate: ch.attributes?.publishAt ?? null,
          };
          const existing = byNumber.get(num);
          if (existing) {
            existing.sources.push(source);
          } else {
            byNumber.set(num, {
              number: num,
              title: ch.attributes?.title || null,
              volume: ch.attributes?.volume ?? null,
              sources: [source],
            });
          }
        }
        offset += limit;
        if (partition) break;
      }
      }

      const entries = Array.from(byNumber.values());
      for (const e of entries) e.sources.sort(orderSources);
      return entries.sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  },

  async getPages(chapterKey: string): Promise<MangaPageEntry[]> {
    try {
      const colonIdx = chapterKey.indexOf(':');
      const chapterId = colonIdx >= 0 ? chapterKey.slice(colonIdx + 1) : chapterKey;
      if (!chapterId) return [];

      const res = await fetchJson<{
        baseUrl?: string;
        chapter?: { hash?: string; data?: string[]; dataSaver?: string[] };
      }>(`${API}/at-home/server/${chapterId}`, { timeoutMs: 12000 });

      const baseUrl = res?.baseUrl;
      const hash = res?.chapter?.hash;
      const files = res?.chapter?.data ?? [];
      if (!baseUrl || !hash || files.length === 0) return [];

      return files.map((file, idx) => ({
        pageNumber: idx + 1,
        imageUrl: `${baseUrl}/data/${hash}/${file}`,
      }));
    } catch {
      return [];
    }
  },
};

export default provider;
