/** JustManga's browser API uses AniList IDs and server-specific chapter keys. */
import type { MangaProvider, MangaChapterParams, MangaChapterEntry, MangaPageEntry } from '../../types/index.js';
import { fetchResponse } from '../../utils/http/fetch.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';
import { isNovelMangaCandidate } from '../../utils/manga/manga-format.js';

const BASE = 'https://justmanga.cc';
const API = 'https://core.justmanga.cc/api';
const HEADERS = { Referer: BASE + '/', Origin: BASE };
interface Manga { id: string; title: string; altTitles?: string[]; type?: string; anilistId?: number }
interface Server { source: string; name: string }
interface Chapter { id: string; key: string; number: number; title?: string; volume?: number; lang?: string; releasedAt?: string; group?: string }
interface Page { index: number; url: string; proxy?: string; width?: number; height?: number }

async function request<T>(path: string): Promise<T | null> {
  const response = await fetchResponse(API + path, { headers: HEADERS, timeoutMs: 5000 });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`JustManga HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
const names = (manga: Manga) => [manga.title, ...(manga.altTitles || [])].filter(Boolean);

async function resolveManga(params: MangaChapterParams): Promise<Manga | null> {
  const id = Number(params.anilistId);
  if (Number.isSafeInteger(id) && id > 0) {
    const manga = await request<Manga>(`/manga/${id}`);
    // An exact AniList lookup must never fall through to a similarly named title.
    return manga && !isNovelMangaCandidate(manga, names(manga)) ? manga : null;
  }
  const titles = await resolveMangaTitles(params);
  const candidates: Manga[] = [];
  for (const title of titles.slice(0, 2)) {
    const results = await request<Manga[]>(`/search/suggestions?q=${encodeURIComponent(title)}&limit=10`);
    candidates.push(...(Array.isArray(results) ? results : []).filter(row => row?.id && !isNovelMangaCandidate(row, names(row))));
    const best = pickBestMangaCandidate(titles, candidates, names, 0.8);
    if (best?.score === 1) return best.candidate;
  }
  return pickBestMangaCandidate(titles, candidates, names, 0.8)?.candidate || null;
}

const provider: MangaProvider = {
  name: 'justmanga', sites: [BASE],
  async getChapters(params): Promise<MangaChapterEntry[]> {
    const manga = await resolveManga(params);
    if (!manga) return [];
    const servers = await request<Server[]>(`/manga/${encodeURIComponent(manga.id)}/servers?lang=en`);
    if (!Array.isArray(servers)) return [];
    const results = await Promise.allSettled(servers.filter(server => /^[\w-]+$/.test(server.source)).map(async server => {
      const result = await request<{ chapters: Chapter[] }>(`/manga/${encodeURIComponent(manga.id)}/chapters?source=${encodeURIComponent(server.source)}&lang=en`);
      const rows: MangaChapterEntry[] = [], seen = new Set<string>();
      for (const chapter of result?.chapters || []) {
        const number = Number(chapter.number), language = chapter.lang || 'en';
        if (chapter.key == null || !Number.isFinite(number) || number < 0) continue;
        const detail = [manga.id, String(chapter.key), language].map(encodeURIComponent).join('|');
        if (seen.has(detail)) continue;
        seen.add(detail);
        const source = `justmanga@${server.source}`;
        rows.push({ number, title: chapter.title || null, volume: chapter.volume == null ? null : String(chapter.volume), sources: [{
          provider: source, providerName: `JustManga · ${server.name}`, chapterKey: `${source}:${detail}`,
          providerChapterId: chapter.id || String(chapter.key), language, scanlator: chapter.group || null,
          releaseDate: chapter.releasedAt || null,
        }] });
      }
      return rows;
    }));
    const answered = results.filter(result => result.status === 'fulfilled');
    if (!answered.length && results.length) throw (results[0] as PromiseRejectedResult).reason;
    const byNumber = new Map<number, MangaChapterEntry>();
    for (const result of answered) {
      if (result.status !== 'fulfilled') continue;
      for (const row of result.value) {
        const prior = byNumber.get(row.number);
        if (prior) prior.sources.push(...row.sources);
        else byNumber.set(row.number, row);
      }
    }
    return [...byNumber.values()].sort((a, b) => a.number - b.number);
  },
  async getPages(chapterKey): Promise<MangaPageEntry[]> {
    const match = /^justmanga@([\w-]+):([^|]+)\|([^|]+)\|([^|]+)$/.exec(chapterKey);
    if (!match) return [];
    let mangaId: string, key: string, language: string;
    try { [mangaId, key, language] = match.slice(2).map(decodeURIComponent); } catch { return []; }
    const result = await request<{ pages: Page[] }>(`/manga/${encodeURIComponent(mangaId!)}/chapters/${encodeURIComponent(key!)}/pages?source=${encodeURIComponent(match[1])}&lang=${encodeURIComponent(language!)}`);
    return [...(result?.pages || [])].sort((a, b) => a.index - b.index).flatMap((page, index) => {
      // Replay the exact signed image query supplied to JustManga's own reader.
      const imageUrl = page.proxy ? `${API}/image?${page.proxy}` : page.url;
      if (!/^https?:\/\//i.test(imageUrl || '')) return [];
      return [{ pageNumber: index + 1, imageUrl, headers: HEADERS, width: page.width ?? null, height: page.height ?? null }];
    });
  },
};
export default provider;
