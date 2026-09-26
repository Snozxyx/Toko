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
  };
  relationships?: Array<{ type: string; attributes?: { name?: string } }>;
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
async function resolveMangaId(params: MangaChapterParams): Promise<string | null> {
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
        if (wantAl && m.attributes?.links?.al === wantAl) return m.id;
      }
    }
  }

  const best = pickBestMangaCandidate(titles, pool, (m) => allNames(m), 0.6);
  return best ? best.candidate.id : null;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: ['https://mangadex.org'],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const mangaId = await resolveMangaId(params);
      if (!mangaId) return [];

      const byNumber = new Map<number, MangaChapterEntry>();
      const limit = 500;
      let offset = 0;
      let total = Infinity;

      // Page through the English feed. limit=500 clears most series in one or
      // two requests; cap total pages so a pathological title can't spin.
      while (offset < total && offset < 5000) {
        const url =
          `${API}/manga/${mangaId}/feed?limit=${limit}&offset=${offset}` +
          `&translatedLanguage[]=en&order[chapter]=asc&order[volume]=asc` +
          `&includes[]=scanlation_group` +
          CONTENT_RATINGS.map((r) => `&contentRating[]=${r}`).join('');
        const res = await fetchJson<{ data?: MdChapter[]; total?: number }>(url, { timeoutMs: 12000 });
        const rows = res?.data ?? [];
        total = typeof res?.total === 'number' ? res.total : rows.length;
        if (rows.length === 0) break;

        for (const ch of rows) {
          const num = parseFloat(String(ch.attributes?.chapter ?? ''));
          if (!Number.isFinite(num)) continue;
          const scanlator =
            ch.relationships?.find((r) => r.type === 'scanlation_group')?.attributes?.name ?? null;
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
      }

      return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
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
