/**
 * Scans.gg — https://scans.gg  (API: https://api.scans.gg)
 *
 * Nuxt 3 SPA backed by a JSON API. Fingerprinted via clean-IP requests on
 * 2026-10-01 (the API wraps every payload in `{ success, data }`):
 *   - Search:   GET /series/search?q={q}   -> { data: Series[] }          [confirmed]
 *   - Chapters: GET /chapters?series_id={id} -> { data: Chapter[] }        [confirmed]
 *   - Pages:    GET /chapters?id={chapterId}  -> { data: Chapter }         [confirmed]
 *               the single-chapter object carries `pages: [{ path }]`.     [confirmed]
 *
 * Series schema (confirmed keys): id, title, alternative_titles[{language,title}],
 * summary, type, status, tags, author, artist, mangabaka, ...  There is NO
 * AniList/MAL link field (only a `mangabaka` id), so mapping is a fuzzy title
 * match against `title` + `alternative_titles[].title`.
 *
 * Chapter schema (confirmed keys): id, series_id, number, volume, title,
 * language, group_id, release_at, created_at, deleted_by_staff, pages.
 *
 * IMAGE HOST — // best-effort: unverified — scans.gg page-image URL.
 *   `cdn.scans.gg` is the image CDN (DNS resolves; 403 at root, 404 for unknown
 *   paths) but the exact path for a page `path`
 *   ("<hash>-<hash>-<hash>-<hash>.avif") could NOT be confirmed over WebFetch —
 *   every guessed prefix 404'd (likely a pull-miss, or a sharded/signed path).
 *   getPages builds `${IMAGE_BASE}/${path}`; if images 404 on deploy, read one
 *   real page URL from the browser Network tab and fix IMAGE_BASE / the join.
 *
 * Requests go through `fetchJsonWithBypass` (same as comick.ts) for Cloudflare
 * resilience; a clean 200 behaves like a plain fetch.
 */
import type {
  MangaProvider,
  MangaChapterEntry,
  MangaChapterParams,
  MangaChapterSource,
  MangaPageEntry,
} from '../../types/index.js';

import { fetchJsonWithBypass } from '../../utils/common/fetch-bypass.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const API_BASE = 'https://api.scans.gg';
const PROVIDER_NAME = 'scansgg';
// best-effort: unverified — confirmed CDN host, path format assumed (see header).
const IMAGE_BASE = 'https://cdn.scans.gg';
const IMAGE_HEADERS = { Referer: 'https://scans.gg/' };
const REQ_HEADERS = { Referer: 'https://scans.gg/' };

interface SgEnvelope<T> {
  success?: boolean;
  data?: T;
}
interface SgAltTitle {
  language?: string | null;
  title?: string | null;
}
interface SgSeries {
  id?: number;
  title?: string | null;
  alternative_titles?: SgAltTitle[] | null;
}
interface SgPage {
  path?: string | null;
}
interface SgChapter {
  id?: number;
  series_id?: number;
  number?: string | number | null;
  volume?: string | number | null;
  title?: string | null;
  language?: string | null;
  group_id?: number | null;
  release_at?: string | null;
  created_at?: string | null;
  deleted_by_staff?: unknown;
  pages?: SgPage[] | null;
}

/** GET an API path and unwrap the `{ success, data }` envelope. */
async function sgGet<T>(path: string, timeoutMs = 12000): Promise<T | null> {
  const res = await fetchJsonWithBypass<SgEnvelope<T>>(`${API_BASE}${path}`, {
    timeoutMs,
    headers: REQ_HEADERS,
  });
  if (!res || res.success === false) return null;
  return (res.data ?? null) as T | null;
}

function seriesNames(s: SgSeries): string[] {
  const names = [s.title, ...((s.alternative_titles ?? []).map((a) => a?.title))];
  return names.filter((n): n is string => Boolean(n && n.trim()));
}

/** Resolve titles to a scans.gg series id via server search + fuzzy match. */
async function resolveSeriesId(params: MangaChapterParams): Promise<number | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const pool: SgSeries[] = [];
  const seen = new Set<number>();
  for (const title of titles.slice(0, 2)) {
    const data = await sgGet<SgSeries[]>(`/series/search?q=${encodeURIComponent(title)}`);
    for (const s of Array.isArray(data) ? data : []) {
      if (typeof s?.id !== 'number' || seen.has(s.id)) continue;
      seen.add(s.id);
      pool.push(s);
    }
  }

  const best = pickBestMangaCandidate(titles, pool, seriesNames, 0.6);
  return best?.candidate.id ?? null;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: ['https://scans.gg'],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const seriesId = await resolveSeriesId(params);
      if (!seriesId) return [];

      const chapters = await sgGet<SgChapter[]>(`/chapters?series_id=${seriesId}`);
      if (!Array.isArray(chapters)) return [];

      const byNumber = new Map<number, MangaChapterEntry>();
      for (const ch of chapters) {
        if (typeof ch?.id !== 'number') continue;
        if (ch.deleted_by_staff) continue; // best-effort: skip staff-removed chapters
        // scans.gg carries chapters in multiple languages; emit each as its own
        // source (grouped by chapter number) so the reader can pick language.
        const lang = (ch.language || 'en').toLowerCase();
        const num = parseFloat(String(ch.number ?? ''));
        if (!Number.isFinite(num)) continue;

        const vol = ch.volume != null && String(ch.volume).trim() ? String(ch.volume) : null;
        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${ch.id}`,
          providerChapterId: String(ch.id),
          language: lang,
          // Only a numeric group_id is exposed, not a scanlator name.
          scanlator: null,
          releaseDate: ch.release_at ?? ch.created_at ?? null,
        };

        const existing = byNumber.get(num);
        if (existing) existing.sources.push(source);
        else byNumber.set(num, { number: num, title: ch.title || null, volume: vol, sources: [source] });
      }

      // English-first within each chapter so the default pick stays English.
      const entries = Array.from(byNumber.values());
      for (const e of entries) {
        e.sources.sort((a, b) => {
          const r = (a.language === 'en' ? 0 : 1) - (b.language === 'en' ? 0 : 1);
          return r !== 0 ? r : a.language.localeCompare(b.language);
        });
      }
      return entries.sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  },

  async getPages(chapterKey: string): Promise<MangaPageEntry[]> {
    try {
      const colonIdx = chapterKey.indexOf(':');
      const id = colonIdx >= 0 ? chapterKey.slice(colonIdx + 1) : chapterKey;
      if (!id) return [];

      const chapter = await sgGet<SgChapter>(`/chapters?id=${encodeURIComponent(id)}`);
      const raw = chapter?.pages ?? [];
      if (!Array.isArray(raw) || raw.length === 0) return [];

      const pages: MangaPageEntry[] = [];
      for (const p of raw) {
        const path = (p?.path || '').trim();
        if (!path) continue;
        const imageUrl = /^https?:\/\//i.test(path)
          ? path
          : `${IMAGE_BASE}/${path.replace(/^\/+/, '')}`;
        pages.push({ pageNumber: pages.length + 1, imageUrl, headers: IMAGE_HEADERS });
      }
      return pages;
    } catch {
      return [];
    }
  },
};

export default provider;
