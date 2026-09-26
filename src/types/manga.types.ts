/**
 * Manga-related type definitions
 * Defines structures for manga chapters, pages, and sources
 */

export interface MangaChapterSource {
  provider: string;
  /** Format: "<provider>:<providerChapterId>" */
  chapterKey: string;
  providerChapterId: string;
  language: string;
  scanlator: string | null;
  releaseDate: string | null;
}

export interface MangaChapterEntry {
  number: number;
  title: string | null;
  volume: string | null;
  sources: MangaChapterSource[];
}

export interface MangaPageEntry {
  pageNumber: number;
  imageUrl: string;
  /** Natural image dimensions when the provider exposes them. */
  width?: number | null;
  height?: number | null;
  /**
   * Per-page request headers (e.g. `{ Referer }`) for CDNs that reject
   * hot-linking. The desktop IPC layer registers `imageUrl` + these headers
   * with the local proxy and returns a `proxiedImageUrl` the reader loads
   * instead. Omit for CDNs that serve images without a Referer (MangaDex).
   */
  headers?: Record<string, string>;
}

export interface MangaChapterParams {
  anilistId?: number;
  malId?: number;
  title?: string;
  /**
   * Resolved AniList titles + synonyms (english, romaji, native, synonyms),
   * best-first. Populated once by the bundle before provider fan-out so each
   * provider fuzzy-searches against the full set instead of re-querying
   * AniList. Providers that map deterministically (MangaDex via `links.al`)
   * ignore this.
   */
  titles?: string[];
}
